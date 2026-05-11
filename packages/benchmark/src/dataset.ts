import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CustomRow, GitChameleonRow, Pool, Sample } from "./types.js";

const HF_DATASET = "cabbage972/GitChameleon-2.0";
const HF_CONFIG = "problems";
const HF_SPLIT = "train";
const ROWS_PER_PAGE = 100;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/gitchameleon.jsonl");
const CUSTOM_PATH = resolve(__dirname, "../data/custom-bleeding-edge.jsonl");

const PROMPT_TEMPLATE = (
  library: string,
  version: string,
  problem: string,
  startingCode: string
): string => {
  const starter = startingCode.trim()
    ? `Starting code (continue from here):\n\`\`\`python\n${startingCode}\n\`\`\`\n`
    : "";
  return `You are an expert Python developer. Solve the problem using the library \`${library}\` pinned to version \`${version}\`. Use only APIs that exist in that exact version. The complete solution must end up in /work/solution.py. Do not include explanations outside the code block.

Problem:
${problem}

${starter}`;
};

interface HfRowsResponse {
  rows: { row: Record<string, unknown> }[];
  num_rows_total: number;
}

function coerceGcRow(raw: Record<string, unknown>): GitChameleonRow {
  const str = (k: string, fallback = "") =>
    typeof raw[k] === "string" ? (raw[k] as string) : fallback;
  const arr = (k: string): string[] => {
    const v = raw[k];
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x));
  };
  return {
    example_id: String(raw.example_id ?? ""),
    library: str("library"),
    version: str("version"),
    python_version: str("python_version", "3.10"),
    problem: str("problem"),
    starting_code: str("starting_code"),
    test: str("test"),
    api_calls: arr("api_calls"),
    name_of_class_or_func: str("name_of_class_or_func"),
    additional_dependencies: str("additional_dependencies"),
    type_of_change: str("type_of_change"),
  };
}

async function fetchAllGcRowsFromHf(): Promise<GitChameleonRow[]> {
  const out: GitChameleonRow[] = [];
  let offset = 0;
  while (true) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", HF_DATASET);
    url.searchParams.set("config", HF_CONFIG);
    url.searchParams.set("split", HF_SPLIT);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(ROWS_PER_PAGE));

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HF datasets-server: ${resp.status} ${resp.statusText}`);
    const body = (await resp.json()) as HfRowsResponse;
    for (const r of body.rows) out.push(coerceGcRow(r.row));
    if (out.length >= body.num_rows_total || body.rows.length === 0) break;
    offset += body.rows.length;
  }
  return out;
}

export async function ensureGitChameleon(force = false): Promise<GitChameleonRow[]> {
  if (!force && existsSync(CACHE_PATH)) {
    const lines = readFileSync(CACHE_PATH, "utf8").trim().split("\n");
    return lines.map((l) => JSON.parse(l) as GitChameleonRow);
  }
  const rows = await fetchAllGcRowsFromHf();
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
}

function loadCustomRows(): CustomRow[] {
  if (!existsSync(CUSTOM_PATH)) return [];
  return readFileSync(CUSTOM_PATH, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CustomRow);
}

function customToSample(row: CustomRow): Sample {
  const gc: GitChameleonRow = {
    example_id: row.id,
    library: row.library,
    version: row.version,
    python_version: row.python_version,
    problem: row.problem,
    starting_code: row.starting_code,
    test: row.test,
    api_calls: [],
    name_of_class_or_func: row.symbol,
    additional_dependencies: row.additional_dependencies,
    type_of_change: row.notes,
  };
  return {
    id: `custom-${row.id}`,
    prompt: PROMPT_TEMPLATE(row.library, row.version, row.problem, row.starting_code),
    pool: "B",
    source: "custom",
    row: gc,
    releaseDate: row.release_date,
    symbol: row.symbol,
  };
}

function gcToSample(row: GitChameleonRow): Sample {
  return {
    id: `gc-${row.example_id}`,
    prompt: PROMPT_TEMPLATE(row.library, row.version, row.problem, row.starting_code),
    pool: "A", // GitChameleon spans 2014-2024 — treat as in-knowledge for current frontier models.
    source: "gitchameleon",
    row,
  };
}

export interface LoadOptions {
  limit?: number;
  libraries?: string[];
  ids?: string[];
  pools?: Pool[];
  source?: "gitchameleon" | "custom" | "all";
}

export async function loadSamples(opts: LoadOptions = {}): Promise<Sample[]> {
  const allowLibs = opts.libraries && new Set(opts.libraries);
  const allowIds = opts.ids && new Set(opts.ids);
  const allowPools = opts.pools && new Set(opts.pools);
  const source = opts.source ?? "all";

  const samples: Sample[] = [];

  if (source === "all" || source === "gitchameleon") {
    const gcRows = await ensureGitChameleon();
    for (const row of gcRows) samples.push(gcToSample(row));
  }
  if (source === "all" || source === "custom") {
    for (const row of loadCustomRows()) samples.push(customToSample(row));
  }

  const filtered: Sample[] = [];
  for (const s of samples) {
    if (allowLibs && !allowLibs.has(s.row.library)) continue;
    if (allowIds && !allowIds.has(s.id) && !allowIds.has(s.row.example_id)) continue;
    if (allowPools && !allowPools.has(s.pool)) continue;
    filtered.push(s);
    if (opts.limit !== undefined && filtered.length >= opts.limit) break;
  }
  return filtered;
}

export const GITCHAMELEON_CACHE = CACHE_PATH;
export const CUSTOM_CACHE = CUSTOM_PATH;

// Backward-compat re-export so scripts still work.
export const ensureDataset = ensureGitChameleon;
