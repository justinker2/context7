import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pLimit from "p-limit";

import { Sandbox } from "./sandbox.js";
import { scoreAstHallucination } from "./scorers/ast-hallucination.js";
import { scorePassAt1 } from "./scorers/pass-at-1.js";
import { solve } from "./solvers/index.js";
import type { Condition, Mode, ModelSpec, RunResult, Sample } from "./types.js";

export interface RunConfig {
  samples: Sample[];
  models: ModelSpec[];
  modes: Mode[];
  conditions: Condition[];
  seeds: number[];
  concurrency: number;
  runDir: string;
  tag?: string;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  total: number;
  ok: number;
  failed: number;
}

function ts(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

interface Cell {
  sample: Sample;
  model: ModelSpec;
  mode: Mode;
  condition: Condition;
  seed: number;
}

async function executeCell(cell: Cell): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  let sandbox: Sandbox | null = null;

  const baseRecord = {
    sampleId: cell.sample.id,
    pool: cell.sample.pool,
    source: cell.sample.source,
    library: cell.sample.row.library,
    version: cell.sample.row.version,
    pythonVersion: cell.sample.row.python_version,
    releaseDate: cell.sample.releaseDate,
    typeOfChange: cell.sample.row.type_of_change,
    model: cell.model.modelId,
    provider: cell.model.provider,
    mode: cell.mode,
    condition: cell.condition,
    seed: cell.seed,
    startedAt,
  };

  try {
    if (cell.mode === "claudecode") {
      if (cell.model.provider !== "anthropic") {
        throw new Error(
          `claudecode mode requires anthropic provider; got ${cell.model.provider}:${cell.model.modelId}`
        );
      }
      if (cell.sample.row.python_version !== "3.10") {
        throw new Error(
          `claudecode mode (v0) only supports python_version=3.10; sample requires ${cell.sample.row.python_version}`
        );
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("claudecode mode requires ANTHROPIC_API_KEY");
      }
    }

    const sandboxEnv: Record<string, string> = {};
    if (cell.mode === "claudecode") {
      if (process.env.ANTHROPIC_API_KEY) sandboxEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.CONTEXT7_API_KEY) sandboxEnv.CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
    }

    sandbox = await Sandbox.start({
      pythonVersion: cell.sample.row.python_version,
      library: cell.sample.row.library,
      version: cell.sample.row.version,
      additionalDeps: cell.sample.row.additional_dependencies,
      variant: cell.mode === "claudecode" ? "claudecode" : "base",
      env: sandboxEnv,
    });

    const output = await solve(cell.mode, cell.condition, cell.sample, cell.model, cell.seed, sandbox);

    const [passAt1, ast] = await Promise.all([
      scorePassAt1(cell.sample, sandbox),
      scoreAstHallucination(cell.sample, sandbox),
    ]);

    return {
      ...baseRecord,
      output,
      passAt1,
      astHallucination: ast,
      completedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    return {
      ...baseRecord,
      output: {
        completion: "",
        solution: "",
        stepCount: 0,
        toolCalls: 0,
        context7Calls: 0,
        runPythonCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
      },
      passAt1: { passed: false, exitCode: -1, stdout: "", stderr: "", durationMs: 0 },
      astHallucination: {
        hallucinated: false,
        unresolvedSymbols: [],
        totalSymbolsChecked: 0,
        syntaxError: null,
        durationMs: 0,
      },
      completedAt: new Date().toISOString(),
      error: (err as Error).message ?? String(err),
    };
  } finally {
    if (sandbox) await sandbox.stop();
  }
}

export async function runBatch(cfg: RunConfig): Promise<RunSummary> {
  const runId = cfg.tag ? `${ts()}-${cfg.tag}` : ts();
  const runDir = join(cfg.runDir, runId);
  await mkdir(runDir, { recursive: true });

  const cells: Cell[] = [];
  for (const sample of cfg.samples) {
    for (const model of cfg.models) {
      for (const mode of cfg.modes) {
        for (const condition of cfg.conditions) {
          for (const seed of cfg.seeds) {
            cells.push({ sample, model, mode, condition, seed });
          }
        }
      }
    }
  }

  await writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify(
      {
        runId,
        startedAt: new Date().toISOString(),
        total: cells.length,
        config: {
          sampleCount: cfg.samples.length,
          pools: [...new Set(cfg.samples.map((s) => s.pool))].sort(),
          sources: [...new Set(cfg.samples.map((s) => s.source))].sort(),
          models: cfg.models,
          modes: cfg.modes,
          conditions: cfg.conditions,
          seeds: cfg.seeds,
          concurrency: cfg.concurrency,
        },
      },
      null,
      2
    )
  );

  const resultsPath = join(runDir, "results.jsonl");
  const limit = pLimit(cfg.concurrency);

  let done = 0;
  let ok = 0;
  let failed = 0;

  await Promise.all(
    cells.map((cell) =>
      limit(async () => {
        const result = await executeCell(cell);
        await appendFile(resultsPath, JSON.stringify(result) + "\n");
        done += 1;
        if (result.error) failed += 1;
        else ok += 1;
        const pct = ((done / cells.length) * 100).toFixed(1);
        process.stderr.write(
          `[${done}/${cells.length} ${pct}%] ${cell.sample.id} ${cell.model.modelId} ${cell.mode}/${cell.condition} pool=${cell.sample.pool} seed=${cell.seed} pass=${result.passAt1.passed} halluc=${result.astHallucination.hallucinated} steps=${result.output.stepCount} tools=${result.output.toolCalls}${result.error ? " err=" + result.error.slice(0, 80) : ""}\n`
        );
      })
    )
  );

  return { runId, runDir, total: cells.length, ok, failed };
}
