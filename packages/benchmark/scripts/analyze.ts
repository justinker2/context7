#!/usr/bin/env tsx
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mcnemar, wilson } from "../src/stats.js";
import type { RunResult } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNS_DIR = resolve(__dirname, "../runs");

function pickRunDir(arg?: string): string {
  if (arg) return resolve(arg);
  const dirs = readdirSync(RUNS_DIR)
    .map((d) => join(RUNS_DIR, d))
    .filter((d) => statSync(d).isDirectory());
  if (dirs.length === 0) throw new Error(`no runs in ${RUNS_DIR}`);
  return dirs.sort().at(-1)!;
}

function loadResults(runDir: string): RunResult[] {
  const path = join(runDir, "results.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunResult);
}

const fmtPct = (x: number) => (x * 100).toFixed(1) + "%";
const fmtCi = (s: { p: number; lo: number; hi: number }) =>
  `${fmtPct(s.p)} [${fmtPct(s.lo)}, ${fmtPct(s.hi)}]`;

interface PairKey {
  sampleId: string;
  model: string;
  mode: string;
  seed: number;
}

function pairResults(results: RunResult[]): Map<string, { baseline?: RunResult; context7?: RunResult }> {
  const out = new Map<string, { baseline?: RunResult; context7?: RunResult }>();
  for (const r of results) {
    if (r.error) continue;
    const k = `${r.sampleId}|${r.model}|${r.mode}|${r.seed}`;
    const slot = out.get(k) ?? {};
    if (r.condition === "baseline") slot.baseline = r;
    else slot.context7 = r;
    out.set(k, slot);
  }
  return out;
}

function pairedDelta(pairs: Iterable<{ baseline?: RunResult; context7?: RunResult }>) {
  let bPassCFail = 0;
  let bFailCPass = 0;
  let bothPass = 0;
  let neither = 0;
  let n = 0;
  for (const p of pairs) {
    if (!p.baseline || !p.context7) continue;
    n += 1;
    const bp = p.baseline.passAt1.passed;
    const cp = p.context7.passAt1.passed;
    if (bp && cp) bothPass += 1;
    else if (!bp && !cp) neither += 1;
    else if (bp && !cp) bPassCFail += 1;
    else bFailCPass += 1;
  }
  const mc = mcnemar(bPassCFail, bFailCPass);
  const baselinePass = bPassCFail + bothPass;
  const context7Pass = bFailCPass + bothPass;
  return {
    n,
    bPassCFail,
    bFailCPass,
    bothPass,
    neither,
    baselineRate: n > 0 ? baselinePass / n : 0,
    context7Rate: n > 0 ? context7Pass / n : 0,
    delta: n > 0 ? (context7Pass - baselinePass) / n : 0,
    mc,
  };
}

function reportArmTable(rs: RunResult[], header: string): string[] {
  const lines: string[] = [];
  const groups = new Map<string, RunResult[]>();
  for (const r of rs) {
    if (r.error) continue;
    const arr = groups.get(r.condition) ?? [];
    arr.push(r);
    groups.set(r.condition, arr);
  }
  lines.push(`### ${header}`);
  lines.push("");
  lines.push("| condition | n | pass@1 (95% CI) | hallucination (95% CI) |");
  lines.push("|---|---|---|---|");
  for (const cond of ["baseline", "context7"]) {
    const arr = groups.get(cond) ?? [];
    if (arr.length === 0) continue;
    const passes = arr.filter((r) => r.passAt1.passed).length;
    const halluc = arr.filter((r) => r.astHallucination.hallucinated).length;
    lines.push(
      `| ${cond} | ${arr.length} | ${fmtCi(wilson(passes, arr.length))} | ${fmtCi(wilson(halluc, arr.length))} |`
    );
  }
  lines.push("");
  return lines;
}

function reportPaired(rs: RunResult[], header: string): string[] {
  const lines: string[] = [];
  const pairs = [...pairResults(rs).values()];
  const d = pairedDelta(pairs);
  lines.push(`### ${header} — paired delta (context7 vs baseline)`);
  lines.push("");
  lines.push(`- n paired: ${d.n}`);
  lines.push(`- baseline pass rate: ${fmtPct(d.baselineRate)}`);
  lines.push(`- context7 pass rate: ${fmtPct(d.context7Rate)}`);
  lines.push(`- Δ (context7 − baseline): **${(d.delta * 100).toFixed(1)} pp**`);
  lines.push(`- discordant pairs: baseline-only=${d.bPassCFail}, context7-only=${d.bFailCPass}`);
  lines.push(
    `- McNemar's (${d.mc.method}): stat=${d.mc.stat.toFixed(3)}, p=${d.mc.pValue.toFixed(4)}`
  );
  lines.push("");
  return lines;
}

function summary(results: RunResult[]): string {
  const lines: string[] = [];

  lines.push("# Run summary");
  lines.push("");
  lines.push(`- total cells: ${results.length}`);
  lines.push(`- failed cells (excluded from rates): ${results.filter((r) => r.error).length}`);
  const ok = results.filter((r) => !r.error);
  lines.push(`- modes: ${[...new Set(ok.map((r) => r.mode))].sort().join(", ")}`);
  lines.push(`- pools: ${[...new Set(ok.map((r) => r.pool))].sort().join(", ")}`);
  lines.push(`- models: ${[...new Set(ok.map((r) => r.model))].sort().join(", ")}`);
  lines.push("");

  lines.push("## Headline: diff-in-diff (Pool A vs Pool B × condition)");
  lines.push("");
  lines.push(
    "If Context7 only helps on bleeding-edge APIs, expect Δ_B (Pool B) to dominate Δ_A (Pool A)."
  );
  lines.push("");
  lines.push("| pool | mode | baseline pass | context7 pass | Δ pp | McNemar p |");
  lines.push("|---|---|---|---|---|---|");
  const modes = [...new Set(ok.map((r) => r.mode))].sort();
  for (const pool of ["A", "B"]) {
    for (const mode of modes) {
      const rs = ok.filter((r) => r.pool === pool && r.mode === mode);
      if (rs.length === 0) continue;
      const d = pairedDelta(pairResults(rs).values());
      lines.push(
        `| ${pool} | ${mode} | ${fmtPct(d.baselineRate)} (n=${d.n}) | ${fmtPct(d.context7Rate)} | ${(d.delta * 100).toFixed(1)} | ${d.mc.pValue.toFixed(4)} |`
      );
    }
  }
  lines.push("");

  lines.push("## Per-(pool × mode) full breakdown");
  lines.push("");
  for (const pool of ["A", "B"]) {
    for (const mode of modes) {
      const rs = ok.filter((r) => r.pool === pool && r.mode === mode);
      if (rs.length === 0) continue;
      lines.push(...reportArmTable(rs, `Pool ${pool} / mode=${mode}`));
      lines.push(...reportPaired(rs, `Pool ${pool} / mode=${mode}`));
    }
  }

  lines.push("## Per-model paired delta (all pools, all modes)");
  lines.push("");
  lines.push("| model | mode | n | baseline | context7 | Δ pp | p |");
  lines.push("|---|---|---|---|---|---|---|");
  const models = [...new Set(ok.map((r) => r.model))].sort();
  for (const m of models) {
    for (const mode of modes) {
      const rs = ok.filter((r) => r.model === m && r.mode === mode);
      if (rs.length === 0) continue;
      const d = pairedDelta(pairResults(rs).values());
      lines.push(
        `| ${m} | ${mode} | ${d.n} | ${fmtPct(d.baselineRate)} | ${fmtPct(d.context7Rate)} | ${(d.delta * 100).toFixed(1)} | ${d.mc.pValue.toFixed(4)} |`
      );
    }
  }
  lines.push("");

  // Token / tool-call cost per arm — useful to defend "is it worth it?"
  lines.push("## Cost per cell (mean tokens, tool calls)");
  lines.push("");
  lines.push("| pool | mode | condition | tokens in | tokens out | tool calls | ctx7 calls | run_python |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const pool of ["A", "B"]) {
    for (const mode of modes) {
      for (const cond of ["baseline", "context7"]) {
        const rs = ok.filter((r) => r.pool === pool && r.mode === mode && r.condition === cond);
        if (rs.length === 0) continue;
        const mean = (sel: (r: RunResult) => number) =>
          rs.reduce((s, r) => s + sel(r), 0) / rs.length;
        lines.push(
          `| ${pool} | ${mode} | ${cond} | ${mean((r) => r.output.tokensIn).toFixed(0)} | ${mean((r) => r.output.tokensOut).toFixed(0)} | ${mean((r) => r.output.toolCalls).toFixed(2)} | ${mean((r) => r.output.context7Calls).toFixed(2)} | ${mean((r) => r.output.runPythonCalls).toFixed(2)} |`
        );
      }
    }
  }
  lines.push("");

  // Top hallucination libraries on baseline (the "where Context7 should help most" signal)
  lines.push("## Top 10 libraries by baseline hallucination rate");
  lines.push("");
  lines.push("| library | n | hallucination |");
  lines.push("|---|---|---|");
  const byLib = new Map<string, RunResult[]>();
  for (const r of ok) {
    if (r.condition !== "baseline") continue;
    const arr = byLib.get(r.library) ?? [];
    arr.push(r);
    byLib.set(r.library, arr);
  }
  const libRows = [...byLib.entries()]
    .map(([lib, arr]) => {
      const h = arr.filter((r) => r.astHallucination.hallucinated).length;
      return { lib, n: arr.length, rate: h / arr.length };
    })
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 10);
  for (const r of libRows) lines.push(`| ${r.lib} | ${r.n} | ${fmtPct(r.rate)} |`);
  lines.push("");

  return lines.join("\n");
}

function main(): void {
  const arg = process.argv[2];
  const runDir = pickRunDir(arg);
  const results = loadResults(runDir);
  const md = summary(results);
  const out = join(runDir, "summary.md");
  writeFileSync(out, md);
  process.stdout.write(md + "\n");
  process.stderr.write(`\nsummary written to ${out}\n`);
}

main();
