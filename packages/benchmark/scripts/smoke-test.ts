#!/usr/bin/env tsx
// Tiny end-to-end check: 3 problems, one model, both conditions, one seed.
// Useful for validating the harness before paying for a full run.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { loadSamples } from "../src/dataset.js";
import { runBatch } from "../src/runner.js";

loadDotenv();

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNS_DIR = resolve(__dirname, "../runs");

const samples = await loadSamples({ limit: 3 });
if (samples.length === 0) {
  process.stderr.write("no samples — run `pnpm download` first\n");
  process.exit(1);
}

const summary = await runBatch({
  samples,
  models: [{ provider: "anthropic", modelId: "claude-sonnet-4-5" }],
  modes: ["agentic"],
  conditions: ["baseline", "context7"],
  seeds: [1],
  concurrency: 2,
  runDir: RUNS_DIR,
  tag: "smoke",
});

process.stdout.write(`\nsmoke run ${summary.runId}: ok=${summary.ok} failed=${summary.failed}\n`);
process.stdout.write(`results: ${summary.runDir}\n`);
