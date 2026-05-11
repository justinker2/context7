export type Condition = "baseline" | "context7";

// "oneshot": single generateText call, optional Context7 doc tools.
// "agentic": custom AI SDK loop with run_python + fs + optional Context7 tools.
// "claudecode": real Claude Code CLI (the production agent customers use)
// running inside the sandbox. Always anthropic models. Closest to ground truth.
export type Mode = "oneshot" | "agentic" | "claudecode";

// "A": in-knowledge — APIs the model has likely seen during training.
// "B": post-cutoff — APIs released after the model's training cutoff. This is
// where Context7 should provide the largest lift, and the comparison Pool A vs
// Pool B is the difference-in-differences test of that hypothesis.
export type Pool = "A" | "B";

export type ProviderId = "anthropic" | "openai" | "google";

export interface ModelSpec {
  provider: ProviderId;
  modelId: string;
}

export interface GitChameleonRow {
  example_id: string;
  library: string;
  version: string;
  python_version: string;
  problem: string;
  starting_code: string;
  test: string;
  api_calls: string[];
  name_of_class_or_func: string;
  additional_dependencies: string;
  type_of_change: string;
}

export interface CustomRow {
  id: string;
  library: string;
  version: string;
  python_version: string;
  problem: string;
  starting_code: string;
  test: string;
  additional_dependencies: string;
  release_date: string; // ISO yyyy-mm-dd
  symbol: string; // the specific API the prompt targets
  notes: string; // why this is post-cutoff / what the stale failure looks like
}

export interface Sample {
  id: string;
  prompt: string;
  pool: Pool;
  source: "gitchameleon" | "custom";
  row: GitChameleonRow;
  releaseDate?: string; // ISO yyyy-mm-dd, populated for custom samples
  symbol?: string;
}

export interface SolverOutput {
  completion: string;
  solution: string;
  stepCount: number;
  toolCalls: number;
  context7Calls: number;
  runPythonCalls: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface PassAt1Score {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface AstHallucinationScore {
  hallucinated: boolean;
  unresolvedSymbols: string[];
  totalSymbolsChecked: number;
  syntaxError: string | null;
  durationMs: number;
}

export interface RunResult {
  sampleId: string;
  pool: Pool;
  source: string;
  library: string;
  version: string;
  pythonVersion: string;
  releaseDate?: string;
  typeOfChange: string;
  model: string;
  provider: ProviderId;
  mode: Mode;
  condition: Condition;
  seed: number;
  output: SolverOutput;
  passAt1: PassAt1Score;
  astHallucination: AstHallucinationScore;
  startedAt: string;
  completedAt: string;
  error: string | null;
}
