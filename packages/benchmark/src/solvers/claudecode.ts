import { extractPython } from "../extract.js";
import type { Sandbox } from "../sandbox.js";
import type { Condition, ModelSpec, Sample, SolverOutput } from "../types.js";

const CLAUDE_MAX_TURNS = 15;
const CLAUDE_TIMEOUT_SEC = 600; // generous wall budget for the whole loop

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
}

interface StreamEvent {
  type?: string;
  message?: { content?: Array<ToolUseBlock | { type: string }> };
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
}

const CONTEXT7_TOOL_PREFIX = "mcp__context7__";

function buildMcpConfig(apiKey: string | undefined): string {
  return JSON.stringify(
    {
      mcpServers: {
        context7: {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          ...(apiKey ? { headers: { CONTEXT7_API_KEY: apiKey } } : {}),
        },
      },
    },
    null,
    2
  );
}

function parseStreamJson(stdout: string): {
  toolCalls: number;
  context7Calls: number;
  bashCalls: number;
  writeCalls: number;
  editCalls: number;
  readCalls: number;
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  numTurns: number;
  costUsd: number;
  isError: boolean;
} {
  let toolCalls = 0;
  let context7Calls = 0;
  let bashCalls = 0;
  let writeCalls = 0;
  let editCalls = 0;
  let readCalls = 0;
  let finalText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let numTurns = 0;
  let costUsd = 0;
  let isError = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }

    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (!block || block.type !== "tool_use") continue;
        const tu = block as ToolUseBlock;
        toolCalls += 1;
        const name = tu.name ?? "";
        if (name.startsWith(CONTEXT7_TOOL_PREFIX)) context7Calls += 1;
        if (name === "Bash") bashCalls += 1;
        if (name === "Write") writeCalls += 1;
        if (name === "Edit") editCalls += 1;
        if (name === "Read") readCalls += 1;
      }
    } else if (ev.type === "result") {
      finalText = ev.result ?? "";
      tokensIn += ev.usage?.input_tokens ?? 0;
      tokensOut += ev.usage?.output_tokens ?? 0;
      cacheReadTokens += ev.usage?.cache_read_input_tokens ?? 0;
      cacheCreateTokens += ev.usage?.cache_creation_input_tokens ?? 0;
      numTurns = ev.num_turns ?? numTurns;
      costUsd = ev.total_cost_usd ?? costUsd;
      if (ev.is_error) isError = true;
    }
  }

  return {
    toolCalls,
    context7Calls,
    bashCalls,
    writeCalls,
    editCalls,
    readCalls,
    finalText,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreateTokens,
    numTurns,
    costUsd,
    isError,
  };
}

export async function solveClaudeCode(
  sample: Sample,
  modelSpec: ModelSpec,
  condition: Condition,
  _seed: number,
  sandbox: Sandbox
): Promise<SolverOutput> {
  if (modelSpec.provider !== "anthropic") {
    throw new Error(
      `claudecode mode only supports anthropic models; got ${modelSpec.provider}:${modelSpec.modelId}`
    );
  }

  const started = Date.now();

  // Prompt → file so we don't have to escape it through shell argv.
  await sandbox.writeWorkFile("_prompt.txt", sample.prompt);

  const useContext7 = condition === "context7";
  const mcpFlag = useContext7 ? "--mcp-config /work/.mcp.json" : "";
  if (useContext7) {
    await sandbox.writeWorkFile(".mcp.json", buildMcpConfig(process.env.CONTEXT7_API_KEY));
  }

  // --permission-mode bypassPermissions: auto-approve all tool calls. The
  // sandbox is the trust boundary; we don't need claude's own gating.
  // --output-format stream-json + --verbose: emits one JSON event per line
  // covering assistant turns, tool_use blocks, tool results, and a final
  // result event with token usage.
  const cmd = [
    "cd /work",
    `claude --print --output-format stream-json --verbose --include-partial-messages=false`,
    `--max-turns ${CLAUDE_MAX_TURNS}`,
    `--model "${modelSpec.modelId}"`,
    `--permission-mode bypassPermissions`,
    mcpFlag,
    `-p "$(cat _prompt.txt)"`,
  ]
    .filter(Boolean)
    .join(" ");

  const r = await sandbox.exec(cmd, { timeoutSec: CLAUDE_TIMEOUT_SEC });
  if (r.timedOut) {
    throw new Error(`claude CLI timed out after ${CLAUDE_TIMEOUT_SEC}s`);
  }

  const parsed = parseStreamJson(r.stdout);

  // Final solution: prefer /work/solution.py (claude code's natural Write path),
  // fall back to extracting a code block from the final text response.
  let solution = (await sandbox.readWorkFile("solution.py")) ?? "";
  if (!solution.trim()) {
    solution = extractPython(parsed.finalText);
    if (solution.trim()) await sandbox.writeWorkFile("solution.py", solution);
  }

  if (parsed.isError && !solution.trim()) {
    throw new Error(
      `claude CLI returned error event with no solution. exitCode=${r.exitCode}; stderr=${r.stderr.slice(0, 500)}`
    );
  }

  return {
    completion: parsed.finalText,
    solution,
    stepCount: parsed.numTurns || parsed.toolCalls,
    toolCalls: parsed.toolCalls,
    context7Calls: parsed.context7Calls,
    runPythonCalls: parsed.bashCalls, // bash plays the role of run_python here
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    durationMs: Date.now() - started,
  };
}
