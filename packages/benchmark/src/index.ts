#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { config as loadDotenv } from "dotenv";

import { ensureGitChameleon, loadSamples } from "./dataset.js";
import { parseModelArg } from "./model.js";
import { runBatch } from "./runner.js";
import type { Condition, Mode, Pool } from "./types.js";

loadDotenv();

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNS_DIR = resolve(__dirname, "../runs");

const program = new Command();
program.name("ctx7-bench").description("Context7 hallucination benchmark");

program
  .command("download")
  .description("Fetch GitChameleon dataset and cache locally")
  .option("--force", "re-fetch even if cached")
  .action(async (opts: { force?: boolean }) => {
    const rows = await ensureGitChameleon(Boolean(opts.force));
    process.stdout.write(`cached ${rows.length} GitChameleon rows\n`);
  });

program
  .command("run")
  .description("Run the benchmark across the (mode × condition × model × seed) cross-product")
  .option("-m, --model <spec...>", "provider:modelId (repeatable)", [
    "anthropic:claude-sonnet-4-5",
  ])
  .option("--mode <name...>", "oneshot|agentic|claudecode (repeatable)", ["agentic"])
  .option("-c, --condition <name...>", "baseline|context7 (repeatable)", [
    "baseline",
    "context7",
  ])
  .option("-s, --seed <n...>", "seed (repeatable)", ["1"])
  .option("--pool <name...>", "A|B (repeatable). Default: both")
  .option("--source <name>", "all|gitchameleon|custom", "all")
  .option("-l, --limit <n>", "cap number of samples", String(Number.MAX_SAFE_INTEGER))
  .option("--library <name...>", "filter to one or more libraries")
  .option("--id <id...>", "filter to specific sample ids")
  .option("--concurrency <n>", "parallel cells", "4")
  .option("--tag <name>", "suffix added to runId for easy reference")
  .action(
    async (opts: {
      model: string[];
      mode: string[];
      condition: string[];
      seed: string[];
      pool?: string[];
      source: string;
      limit: string;
      library?: string[];
      id?: string[];
      concurrency: string;
      tag?: string;
    }) => {
      const pools = opts.pool?.map((p) => {
        if (p !== "A" && p !== "B") throw new Error(`unknown pool "${p}"`);
        return p as Pool;
      });
      const source = opts.source as "all" | "gitchameleon" | "custom";
      if (!["all", "gitchameleon", "custom"].includes(source)) {
        throw new Error(`unknown --source "${opts.source}"`);
      }

      const samples = await loadSamples({
        limit: Number(opts.limit) || undefined,
        libraries: opts.library,
        ids: opts.id,
        pools,
        source,
      });
      if (samples.length === 0) {
        process.stderr.write("no samples matched filters\n");
        process.exit(1);
      }

      const models = opts.model.map(parseModelArg);
      const modes = opts.mode.map((m) => {
        if (m !== "oneshot" && m !== "agentic" && m !== "claudecode")
          throw new Error(`unknown mode "${m}"`);
        return m as Mode;
      });
      const conditions = opts.condition.map((c) => {
        if (c !== "baseline" && c !== "context7") throw new Error(`unknown condition "${c}"`);
        return c as Condition;
      });
      const seeds = opts.seed.map((s) => Number(s));

      const totalCells = samples.length * models.length * modes.length * conditions.length * seeds.length;
      process.stderr.write(
        `running: samples=${samples.length} models=${models.length} modes=${modes.length} conditions=${conditions.length} seeds=${seeds.length} -> ${totalCells} cells\n`
      );
      const poolBreakdown = samples.reduce<Record<string, number>>((acc, s) => {
        acc[s.pool] = (acc[s.pool] ?? 0) + 1;
        return acc;
      }, {});
      process.stderr.write(`pool breakdown: ${JSON.stringify(poolBreakdown)}\n`);

      const summary = await runBatch({
        samples,
        models,
        modes,
        conditions,
        seeds,
        concurrency: Number(opts.concurrency),
        runDir: RUNS_DIR,
        tag: opts.tag,
      });

      process.stdout.write(
        `\nrun ${summary.runId}: ok=${summary.ok} failed=${summary.failed} -> ${summary.runDir}\n`
      );
    }
  );

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
