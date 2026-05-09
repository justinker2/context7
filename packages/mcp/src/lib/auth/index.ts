import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ClientContext } from "../encryption.js";
import {
  getState,
  persistState,
  emptyState,
  isForcePrompt,
  PROMPT_AFTER_CALLS,
  PROMPT_COOLDOWN_MS,
  MAX_DISMISSALS,
  __testInternals,
  type PromptState,
} from "./state.js";
import {
  clientCapabilities,
  runStdioUrlElicitation,
  runFormElicitation,
  runHttpUrlElicitation,
  runHttpFormElicitation,
} from "./elicit.js";
import { runOAuthFlow } from "./oauth.js";

export { recordCallAndDecide, isAuthenticated } from "./state.js";
export { loadStdioToken } from "./oauth.js";

const DEBUG = process.env.CONTEXT7_AUTH_PROMPT_DEBUG === "1";
function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[Context7:auth-prompt]", ...args);
}

interface PromptOptions {
  context: ClientContext;
  server: Server;
}

export interface PromptResult {
  /** True when an elicitation was sent. False when the client lacks
   *  elicitation capability and the caller should append an inline tip. */
  shown: boolean;
}

export async function promptForAuth({ context, server }: PromptOptions): Promise<PromptResult> {
  const state = getState(context);
  const caps = clientCapabilities(server);
  debug("promptForAuth", { transport: context.transport, caps, count: state.count });

  // For remote HTTP servers, neither URL-mode (clients reject it) nor
  // form-mode-then-server-opens-browser (the server isn't on the user's
  // machine) actually delivers a clickable sign-in path. Skip elicit and
  // fall through to the inline tool-result nudge, whose markdown link DOES
  // render clickably in agent chat output.
  if (context.transport === "http" && !isLocalServerOrigin(context.serverOrigin)) {
    return { shown: false };
  }

  if (!caps.form && !caps.url) return { shown: false };

  if (context.transport === "stdio") {
    if (caps.url) {
      const outcome = await runStdioUrlElicitation({ context, server, state });
      if (outcome !== "no-response") return { shown: true };
    }
    if (caps.form) {
      const accepted = await runFormElicitation({ context, server, state });
      if (accepted) return { shown: true };
    }
    return { shown: false };
  }

  if (caps.url) {
    const outcome = await runHttpUrlElicitation({ context, server, state });
    if (outcome !== "no-response") return { shown: true };
  }
  if (caps.form) {
    const accepted = await runHttpFormElicitation({ context, server, state });
    if (accepted) return { shown: true };
  }
  return { shown: false };
}

function isLocalServerOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export interface InlineAuthNudgeOptions {
  /** Set when the tool's API response actually surfaced a rate-limit / quota
   *  error. Drives whether we use the "limit reached" framing or the softer
   *  "anonymous user, consider signing in" framing. */
  rateLimited?: boolean;
}

/**
 * Append-once tip for clients whose elicitation rendering is broken or
 * unsupported. Embeds a clickable OAuth URL in the tool's text result so the
 * user can sign in without a dialog; the localhost callback is started
 * eagerly so a single click completes the flow. Marks the fingerprint
 * opted-out so this fires at most once per client.
 */
/** Server origin counts as "local" if it's reachable as localhost from the
 *  user's browser — i.e. the OAuth callback we'd spin up on port 52417 can
 *  actually receive the redirect. Anything else is treated as a remote
 *  deployment where the localhost-callback approach won't work. */
function isLocalServer(serverOrigin: string | undefined): boolean {
  if (!serverOrigin) return true; // stdio (no URL involved) is always local
  try {
    const host = new URL(serverOrigin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Map the `clientInfo.name` from the MCP initialize handshake to the
 * matching `ctx7 setup` flag. Returns the empty string when the client is
 * unknown — the caller falls back to interactive setup.
 */
function clientFlagForCli(ide: string | undefined): string {
  if (!ide) return "";
  const lower = ide.toLowerCase();
  if (lower.includes("cursor")) return "--cursor";
  if (lower.includes("claude")) return "--claude";
  if (lower.includes("codex")) return "--codex";
  if (lower.includes("opencode")) return "--opencode";
  if (lower.includes("gemini")) return "--gemini";
  return "";
}

export function inlineAuthNudge(context: ClientContext, opts: InlineAuthNudgeOptions = {}): string {
  const state = getState(context);
  if (!isForcePrompt()) {
    state.optedOut = true;
    state.lastPromptedAt = Date.now();
    persistState(context, state);
  }

  const tag = opts.rateLimited ? "[Rate limit reached]" : "[Heads up]";
  const reason = opts.rateLimited
    ? "Context7's free anonymous rate limit was just hit."
    : "This user is using Context7 anonymously.";

  // Remote deployment: the server can't run a localhost OAuth callback for
  // the user's browser, and it shouldn't hold tokens at rest. The
  // `ctx7 setup` CLI does the OAuth flow on the user's machine and writes
  // the access token into their MCP client config; the next reconnect picks
  // it up. We pass the right client flag so the CLI targets the editor
  // they're actually using.
  if (context.transport !== "stdio" && !isLocalServer(context.serverOrigin)) {
    const clientFlag = clientFlagForCli(context.clientInfo?.ide);
    const command = clientFlag
      ? `npx ctx7 setup ${clientFlag} --mcp -y`
      : `npx ctx7 setup --mcp`;
    return [
      "---",
      `**${tag} Notice for the user — please relay the following section to them and offer to run the command for them after their confirmation:**`,
      "",
      "> You're using Context7 anonymously. To sign in for **free** higher rate limits and personalized results, run this in your terminal:",
      ">",
      "> ```",
      `> ${command}`,
      "> ```",
      ">",
      "> It opens the browser, completes sign-in, and writes the access token into your MCP client config. After it finishes, disable + re-enable the Context7 MCP server in your editor so the new credentials take effect.",
      "",
      `(Background for the assistant: ${reason} Surface the notice above to the user; with their permission, you may run \`${command}\` for them via your shell tool.)`,
    ].join("\n");
  }

  // Local stdio or local HTTP dev: spin up the localhost callback and hand
  // the user a one-click OAuth URL.
  const url = runOAuthFlow({
    openInBrowser: false,
    clientName: context.clientInfo?.ide,
    serverOrigin: context.serverOrigin,
  });

  return [
    "---",
    `**${tag} Notice for the user — please relay the following section to them, preserving the markdown link as a clickable hyperlink:**`,
    "",
    "> You're using Context7 anonymously. Sign in for **free** to unlock:",
    "> - Higher rate limits",
    "> - Personalized library results",
    "> - Automatic authentication for every tool call in this session",
    ">",
    `> 👉 [Click here to sign in to Context7](${url})`,
    ">",
    "> Sign-in is one click and opens in your browser. No API keys to copy or configure.",
    "",
    `(Background for the assistant: ${reason} The notice above is intended for the end user and should be surfaced in your reply, not buried.)`,
  ].join("\n");
}

export const __test = {
  ...__testInternals,
  emptyState,
  PROMPT_AFTER_CALLS,
  PROMPT_COOLDOWN_MS,
  MAX_DISMISSALS,
} as const;

export type { PromptState };
