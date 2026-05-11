import { randomUUID } from "node:crypto";

import { queryDocs, resolveLibraryId } from "@upstash/context7-tools-ai-sdk";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { extractPython } from "../extract.js";
import { getModel } from "../model.js";
import type { Sandbox } from "../sandbox.js";
import type { Condition, ModelSpec, Sample, SolverOutput } from "../types.js";

const AGENTIC_MAX_STEPS = 15;
const RUN_PYTHON_TIMEOUT_SEC = 30;

const SYSTEM_PROMPT = (forContext7: boolean) => `You are a Python coding agent solving a problem against a pinned library version inside a Linux sandbox.

Your workspace is /work. Write your final solution to /work/solution.py.

Tools:
- run_python(code): execute Python in the sandbox. Use it to introspect the installed library (e.g. dir, help, inspect.signature), test small snippets, and verify your solution.
- write_file(name, content): write a file under /work/<name>. Use this to save solution.py.
- read_file(name): read a file under /work/<name>.
- list_files(): list files under /work.${
  forContext7
    ? `
- resolveLibraryId(libraryName, query): get a Context7-compatible library ID.
- queryDocs(libraryId, query): fetch live, version-aware documentation. Prefer this over what you remember from training when working with pinned versions.`
    : ""
}

Rules:
- Always finish by writing the complete solution to /work/solution.py with write_file.
- Verify your solution runs with run_python before stopping.
- Keep run_python calls focused — short snippets, not long debugging dumps.
- Stop once /work/solution.py is written and a final verification has passed.`;

export async function solveAgentic(
  sample: Sample,
  modelSpec: ModelSpec,
  condition: Condition,
  seed: number,
  sandbox: Sandbox
): Promise<SolverOutput> {
  const started = Date.now();
  const apiKey = process.env.CONTEXT7_API_KEY;
  const useContext7 = condition === "context7";

  const counters = { runPython: 0, context7: 0 };

  const tools = {
    run_python: tool({
      description:
        "Run Python code in the sandbox. Returns exit code, stdout, stderr. Use for introspection (dir, inspect, help) and to verify your solution.",
      inputSchema: z.object({
        code: z.string().describe("Python source. Executed as a script in /work."),
      }),
      execute: async ({ code }: { code: string }) => {
        counters.runPython += 1;
        const fname = `_run_${randomUUID().slice(0, 8)}.py`;
        await sandbox.writeWorkFile(fname, code);
        const r = await sandbox.exec(`python ${fname}`, {
          timeoutSec: RUN_PYTHON_TIMEOUT_SEC,
        });
        return JSON.stringify({
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          stdout: r.stdout.slice(-2000),
          stderr: r.stderr.slice(-2000),
        });
      },
    }),
    write_file: tool({
      description:
        "Write a file under /work/<name>. The agent's final solution must be written to /work/solution.py.",
      inputSchema: z.object({
        name: z.string().describe("File name relative to /work. No subdirs, no '..'."),
        content: z.string(),
      }),
      execute: async ({ name, content }: { name: string; content: string }) => {
        await sandbox.writeWorkFile(name, content);
        return `wrote ${content.length} bytes to /work/${name}`;
      },
    }),
    read_file: tool({
      description: "Read a file under /work/<name>. Returns the file contents or 'not found'.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }: { name: string }) => {
        const c = await sandbox.readWorkFile(name);
        return c ?? `not found: ${name}`;
      },
    }),
    list_files: tool({
      description: "List files in /work.",
      inputSchema: z.object({}),
      execute: async () => {
        const entries = await sandbox.listWorkFiles();
        return entries.length === 0 ? "(empty)" : entries.join("\n");
      },
    }),
    ...(useContext7
      ? {
          resolveLibraryId: resolveLibraryId(apiKey ? { apiKey } : {}),
          queryDocs: queryDocs(apiKey ? { apiKey } : {}),
        }
      : {}),
  };

  const result = await generateText({
    model: getModel(modelSpec),
    system: SYSTEM_PROMPT(useContext7),
    prompt: sample.prompt,
    temperature: 0,
    seed,
    tools,
    stopWhen: stepCountIs(AGENTIC_MAX_STEPS),
  });

  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const step of result.steps ?? []) {
    const calls = step.toolCalls ?? [];
    toolCalls += calls.length;
    for (const c of calls) {
      if (!c) continue;
      if (c.toolName === "resolveLibraryId" || c.toolName === "queryDocs") counters.context7 += 1;
    }
    tokensIn += step.usage?.inputTokens ?? 0;
    tokensOut += step.usage?.outputTokens ?? 0;
  }

  // Final solution: prefer the file the agent wrote. Fall back to extracting
  // a code block from its final text response if it forgot.
  let solution = (await sandbox.readWorkFile("solution.py")) ?? "";
  if (!solution.trim()) {
    solution = extractPython(result.text);
    if (solution.trim()) await sandbox.writeWorkFile("solution.py", solution);
  }

  return {
    completion: result.text,
    solution,
    stepCount: result.steps?.length ?? 0,
    toolCalls,
    context7Calls: counters.context7,
    runPythonCalls: counters.runPython,
    tokensIn,
    tokensOut,
    durationMs: Date.now() - started,
  };
}
