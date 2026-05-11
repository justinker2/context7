import { queryDocs, resolveLibraryId } from "@upstash/context7-tools-ai-sdk";
import { generateText, stepCountIs } from "ai";

import { extractPython } from "../extract.js";
import { getModel } from "../model.js";
import type { Sandbox } from "../sandbox.js";
import type { Condition, ModelSpec, Sample, SolverOutput } from "../types.js";

const ONESHOT_MAX_STEPS = 8;

const SYSTEM_BASELINE = `You are an expert Python developer. Return a single Python code block containing the complete solution. Do not include explanations outside the code block.`;

const SYSTEM_CONTEXT7 = `You are an expert Python developer. You have access to Context7 tools that fetch live, version-aware documentation for any library. When the user pins a library to a specific version, use the tools to verify API signatures and check for recent changes before writing code. Prefer the documented API over what you remember from training.

When you have enough information, return a single Python code block containing the complete solution. Do not include explanations outside the code block.`;

export async function solveOneShot(
  sample: Sample,
  modelSpec: ModelSpec,
  condition: Condition,
  seed: number,
  sandbox: Sandbox
): Promise<SolverOutput> {
  const started = Date.now();
  const apiKey = process.env.CONTEXT7_API_KEY;
  const useTools = condition === "context7";

  const result = await generateText({
    model: getModel(modelSpec),
    system: useTools ? SYSTEM_CONTEXT7 : SYSTEM_BASELINE,
    prompt: sample.prompt,
    temperature: 0,
    seed,
    ...(useTools
      ? {
          tools: {
            resolveLibraryId: resolveLibraryId(apiKey ? { apiKey } : {}),
            queryDocs: queryDocs(apiKey ? { apiKey } : {}),
          },
          stopWhen: stepCountIs(ONESHOT_MAX_STEPS),
        }
      : {}),
  });

  const solution = extractPython(result.text);
  await sandbox.writeWorkFile("solution.py", solution);

  let toolCalls = 0;
  let context7Calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const step of result.steps ?? []) {
    const calls = step.toolCalls ?? [];
    toolCalls += calls.length;
    for (const c of calls) {
      if (!c) continue;
      if (c.toolName === "resolveLibraryId" || c.toolName === "queryDocs") context7Calls += 1;
    }
    tokensIn += step.usage?.inputTokens ?? 0;
    tokensOut += step.usage?.outputTokens ?? 0;
  }
  if ((result.steps?.length ?? 0) === 0) {
    tokensIn = result.usage.inputTokens ?? 0;
    tokensOut = result.usage.outputTokens ?? 0;
  }

  return {
    completion: result.text,
    solution,
    stepCount: result.steps?.length ?? 1,
    toolCalls,
    context7Calls,
    runPythonCalls: 0,
    tokensIn,
    tokensOut,
    durationMs: Date.now() - started,
  };
}
