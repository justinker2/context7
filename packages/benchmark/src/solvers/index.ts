import type { Sandbox } from "../sandbox.js";
import type { Condition, Mode, ModelSpec, Sample, SolverOutput } from "../types.js";
import { solveAgentic } from "./agentic.js";
import { solveClaudeCode } from "./claudecode.js";
import { solveOneShot } from "./one-shot.js";

export function solve(
  mode: Mode,
  condition: Condition,
  sample: Sample,
  model: ModelSpec,
  seed: number,
  sandbox: Sandbox
): Promise<SolverOutput> {
  switch (mode) {
    case "oneshot":
      return solveOneShot(sample, model, condition, seed, sandbox);
    case "agentic":
      return solveAgentic(sample, model, condition, seed, sandbox);
    case "claudecode":
      return solveClaudeCode(sample, model, condition, seed, sandbox);
  }
}
