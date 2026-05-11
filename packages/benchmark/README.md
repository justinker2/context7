# Context7 Benchmark

Measures whether Context7 reduces API hallucination and increases pass@1 for
coding agents — both **single-shot** and **agentic** — across two recency pools:

- **Pool A (in-knowledge)**: APIs the model has likely seen in training. Sourced
  from GitChameleon 2.0 (328 problems, 26 Python libraries, 2014–2024).
- **Pool B (post-cutoff)**: APIs released *after* the model's training cutoff
  (Jan 2026 for Claude Opus 4.7). Sourced from a custom prompt set in
  `data/custom-bleeding-edge.jsonl`.

The result we want to show is a **diff-in-diff**: Context7's lift on Pool B
minus its lift on Pool A. If Context7 helps everywhere equally we'd expect
Δ_A ≈ Δ_B. If Context7 specifically helps with bleeding-edge APIs (the actual
pitch) we expect Δ_B >> Δ_A.

## Three modes

Each problem is run in one or more modes, all gated by the same A/B condition
flag:

- **`oneshot`** — `generateText` once. The agent has access to `resolveLibraryId`
  and `queryDocs` only when `condition=context7`. No code execution. Cheap and
  fast — useful as a lower bound on agent capability. Works with any model
  provider (anthropic, openai, google).
- **`agentic`** — custom AI SDK multi-step tool loop (up to 15 steps). The
  agent has `run_python`, `write_file`, `read_file`, `list_files`, plus (in
  `context7`) the Context7 doc-fetch tools. The model writes code, runs it,
  sees the error, iterates. Synthetic but model-agnostic — runs on any
  provider.
- **`claudecode`** — the actual Claude Code CLI in headless mode (`claude -p
  ... --output-format stream-json --max-turns 15`), running inside the
  sandbox. The agent has the full production tool set (Bash, Read, Write,
  Edit, Glob, Grep) plus the Context7 MCP server when `condition=context7`.
  This is the most realistic test of how Context7 actually performs for
  customers using Claude Code. Anthropic-only (it's their CLI). Currently
  v0 is python_version=3.10 only — older Python images don't ship Node 22.

`claudecode` is the headline mode. `oneshot` and `agentic` are useful for
provider-comparison and as cheaper baselines.

Each sample × model × seed × mode × condition produces one cell.

## Two scorers (run on every cell)

- **`pass@1`** — primary. The model's `/work/solution.py` is executed against
  the problem's hidden tests inside the same Docker sandbox the agent worked
  in. Pass / fail comes from the test exit code.
- **`ast_hallucination`** — secondary. Parse the solution with Python `ast`,
  resolve every attribute chain rooted at an imported module via `getattr`
  against the actually installed package. Unresolved chains → flagged. Lets
  us separate "API doesn't exist" failures from "API exists but logic was wrong."

## Why this benchmark

GitChameleon 2.0 (Apache-2.0, arXiv 2507.12367) is the strongest publicly
available version-aware code benchmark. No vendor in the doc-retrieval space
(Nia, Exa-code, Ref, DeepWiki) has published a Context7 delta on it, so the
result anchors a comparison nobody else has run. The Pool B custom set then
puts a number on the actual customer ask: "does Context7 help my agent on
APIs that came out yesterday?"

## Layout

```
packages/benchmark/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── data/
│   ├── gitchameleon.jsonl                 # cached after first download
│   └── custom-bleeding-edge.jsonl         # Pool B seed set (extensible)
├── docker/
│   ├── Dockerfile                         # base python image (parameterized by PY_VERSION)
│   ├── Dockerfile.claudecode              # base + Node + Claude Code CLI (py310 only)
│   └── build.sh                           # builds all images
├── src/
│   ├── index.ts                           # ctx7-bench CLI
│   ├── types.ts                           # Sample, RunResult, Mode, Pool, ...
│   ├── dataset.ts                         # GitChameleon + custom loader
│   ├── extract.ts                         # pull Python from completion
│   ├── sandbox.ts                         # long-lived per-cell Docker sandbox
│   ├── stats.ts                           # Wilson 95% CI + McNemar's
│   ├── runner.ts                          # cell loop, manifest, JSONL log
│   ├── model.ts                           # provider:modelId parser
│   ├── solvers/
│   │   ├── one-shot.ts                    # generateText with optional Context7 tools
│   │   ├── agentic.ts                     # custom AI SDK loop with run_python + fs + Context7
│   │   ├── claudecode.ts                  # real claude CLI in -p mode, full tool set + Context7 MCP
│   │   └── index.ts
│   └── scorers/
│       ├── pass-at-1.ts
│       └── ast-hallucination.ts
└── scripts/
    ├── download-dataset.ts
    ├── smoke-test.ts                      # 3 problems, agentic, both arms
    └── analyze.ts                         # writes summary.md with diff-in-diff
```

## Setup

```bash
cd packages/benchmark
pnpm install
cp .env.example .env   # fill in keys
./docker/build.sh      # builds py37/py39/py310 sandbox images (~10 min first time)
pnpm download          # caches 328 GitChameleon rows to data/
```

## Run

Smoke test (3 problems, claude-sonnet-4-5, agentic, both arms):

```bash
pnpm smoke
```

Full single-model run, agentic only, both pools:

```bash
pnpm exec ctx7-bench run \
  --model anthropic:claude-sonnet-4-5 \
  --mode agentic \
  --condition baseline --condition context7 \
  --seed 1 --seed 2 --seed 3 \
  --concurrency 6 \
  --tag full-sonnet
```

Full single-model run, both modes (oneshot lower bound + agentic):

```bash
pnpm exec ctx7-bench run \
  --model anthropic:claude-opus-4-7 \
  --mode oneshot --mode agentic \
  --condition baseline --condition context7 \
  --seed 1 \
  --concurrency 6 \
  --tag opus-both-modes
```

Claude Code mode on Pool B (the most realistic and headline-worthy run):

```bash
pnpm exec ctx7-bench run \
  --model anthropic:claude-opus-4-7 \
  --mode claudecode \
  --condition baseline --condition context7 \
  --pool B \
  --seed 1 --seed 2 --seed 3 \
  --tag opus-cc-poolB
```

Pool B only, agentic mode (cheaper baseline):

```bash
pnpm exec ctx7-bench run \
  --model anthropic:claude-opus-4-7 \
  --mode agentic \
  --condition baseline --condition context7 \
  --pool B \
  --seed 1 --seed 2 --seed 3 \
  --tag opus-poolB
```

Multi-model (use seed=1 to keep cost down):

```bash
pnpm exec ctx7-bench run \
  --model anthropic:claude-opus-4-7 \
  --model openai:gpt-5 \
  --model google:gemini-2.5-pro \
  --mode agentic \
  --condition baseline --condition context7 \
  --seed 1
```

Analyze any run (defaults to most recent):

```bash
pnpm analyze              # most recent runs/<id>/
pnpm analyze runs/<id>    # explicit
```

The analyzer writes `summary.md` next to `results.jsonl` containing:

- **Headline diff-in-diff table** — pool × mode × condition with paired Δ and McNemar's p
- **Per-(pool, mode) full breakdown** — Wilson 95% CI per arm
- **Per-model paired delta**
- **Cost per cell** — mean tokens, tool calls, run_python calls, ctx7 calls
- **Top 10 libraries by baseline hallucination rate**

## Pool B: extending the custom prompt set

`data/custom-bleeding-edge.jsonl` is a JSONL file. Each line is one prompt:

```json
{
  "id": "duckdb-150-variant",
  "library": "duckdb",
  "version": "1.5.0",
  "python_version": "3.10",
  "problem": "Write a function `setup_variant_table(con)` that ...",
  "starting_code": "",
  "test": "import duckdb\ncon = duckdb.connect(':memory:')\nsetup_variant_table(con)\nassert ...",
  "additional_dependencies": "",
  "release_date": "2026-03-09",
  "symbol": "VARIANT type",
  "notes": "Stale model will fall back to JSON or STRUCT — those existed pre-1.5"
}
```

To add a candidate, append one line. Criteria:

1. **Pinned version exists on PyPI** (`pip install <library>==<version>` must work).
2. **Released after the target model's cutoff.** For Claude Opus 4.7 that's
   January 2026. Verify the date against the library's release notes.
3. **Test is deterministic and self-contained.** No outbound network calls,
   no GPU, no external services. The hidden tests are exec'd in the same
   namespace as the solution — call functions the solution defined.
4. **Stale failure mode is identifiable.** Briefly describe in `notes` what a
   model with pre-cutoff training data will probably write instead. The test
   should fail on that pattern.

The seed set in this file came from a research pass over Jan–May 2026 library
releases. The 6 entries currently in the file are drafts — verify each
against the actual library version on PyPI before relying on the result.

## What's intentionally *not* in v1

- TypeScript libraries (Vercel AI SDK 6.x, Astro 6, Next.js 16.2) — would need
  a Node sandbox image. Big second-language coverage win, but v2.
- Head-to-head against Nia / Exa-code / Ref / DeepWiki MCPs as separate
  conditions. The architecture supports it — add a new solver per provider.
- Per-model cutoff dates. Currently we treat all GitChameleon as Pool A and
  the custom set as Pool B. A more rigorous design would map each
  `(model, sample.release_date)` to a pool individually.

## Cost note (rough)

Agentic runs cost more than one-shot because of the tool loop. Sonnet 4.5 at
agentic, ~10 steps average, ~$0.25 per cell. A full Pool A + Pool B pass
(334 samples × 2 conditions × 1 seed = 668 cells) ≈ $170 and ~2 hours wall
at concurrency 6.
