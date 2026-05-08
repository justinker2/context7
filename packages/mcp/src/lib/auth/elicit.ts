import * as crypto from "crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClientContext } from "../encryption.js";
import { bumpDecline, envInt, markPrompted, type PromptState } from "./state.js";
import { runOAuthFlow } from "./oauth.js";

const ELICIT_TIMEOUT_MS = envInt("CONTEXT7_ELICIT_TIMEOUT_MS", 2 * 60 * 1000);

const DEBUG = process.env.CONTEXT7_AUTH_PROMPT_DEBUG === "1";
function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[Context7:auth-prompt]", ...args);
}

const PROMPT_MESSAGE =
  "Sign in to Context7 for higher rate limits. Accept to open the sign-in page in your browser.";

// Empty schema renders as a pure approval prompt (Accept / Decline) in every
// client we've tested. Codex additionally surfaces "Allow for this session"
// and "Always allow" buttons when `_meta.persist` is set (per
// openai/codex#17043) — other clients ignore the meta.
const CODEX_FORM_PARAMS = {
  requestedSchema: { type: "object", properties: {} },
  _meta: { persist: ["session", "always"] },
} as const;

const GENERIC_FORM_PARAMS = {
  requestedSchema: { type: "object", properties: {} },
} as const;

function pickFormParams(clientName: string | undefined): Record<string, unknown> {
  if (clientName && clientName.toLowerCase().includes("codex")) {
    return { ...CODEX_FORM_PARAMS };
  }
  return { ...GENERIC_FORM_PARAMS };
}

interface ElicitResponseMeta {
  persist?: string;
}

interface CapabilitySnapshot {
  form: boolean;
  url: boolean;
}

export function clientCapabilities(server: Server): CapabilitySnapshot {
  const caps = server.getClientCapabilities();
  const elicit = caps?.elicitation as { form?: object; url?: object } | undefined;
  if (!elicit) return { form: false, url: false };
  // Per spec: an empty `elicitation` object means form-only support.
  const explicit = "form" in elicit || "url" in elicit;
  return {
    form: explicit ? Boolean(elicit.form) : true,
    url: explicit ? Boolean(elicit.url) : false,
  };
}

/**
 * Send `elicitation/create` directly via the protocol layer, bypassing the
 * SDK's `elicitInput` helper. The helper enforces a strict client-capability
 * pre-check that fails for clients that declare an empty `elicitation: {}`,
 * even though those clients can actually render the request.
 */
async function sendElicitation(
  server: Server,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<ElicitResult> {
  return (await server.request({ method: "elicitation/create", params }, ElicitResultSchema, {
    timeout: timeoutMs,
  })) as ElicitResult;
}

type UrlElicitOutcome = "accept" | "decline" | "cancel" | "no-response";

interface ElicitContext {
  context: ClientContext;
  server: Server;
  state: PromptState;
}

export async function runStdioUrlElicitation({
  context,
  server,
  state,
}: ElicitContext): Promise<UrlElicitOutcome> {
  const url = runOAuthFlow({
    openInBrowser: false,
    clientName: context.clientInfo?.ide,
    serverOrigin: context.serverOrigin,
  });

  let result;
  try {
    result = await sendElicitation(
      server,
      { mode: "url", message: PROMPT_MESSAGE, url, elicitationId: crypto.randomUUID() },
      ELICIT_TIMEOUT_MS
    );
  } catch (error) {
    console.error("[Context7] Auth elicitation failed:", error);
    return "no-response";
  }

  if (result.action !== "accept") {
    bumpDecline(context, state);
    return result.action === "decline" ? "decline" : "cancel";
  }
  markPrompted(context, state);
  return "accept";
}

export async function runFormElicitation({
  context,
  server,
  state,
}: ElicitContext): Promise<boolean> {
  let result;
  try {
    result = await sendElicitation(
      server,
      { mode: "form", message: PROMPT_MESSAGE, ...pickFormParams(context.clientInfo?.ide) },
      ELICIT_TIMEOUT_MS
    );
  } catch (error) {
    console.error("[Context7] Auth elicitation failed:", error);
    return false;
  }
  return await applyPromptChoice(result, { context, server, state });
}

export async function runHttpUrlElicitation({
  context,
  server,
  state,
}: ElicitContext): Promise<UrlElicitOutcome> {
  const url = runOAuthFlow({
    openInBrowser: false,
    clientName: context.clientInfo?.ide,
    serverOrigin: context.serverOrigin,
  });

  let result;
  try {
    result = await sendElicitation(
      server,
      { mode: "url", message: PROMPT_MESSAGE, url, elicitationId: crypto.randomUUID() },
      ELICIT_TIMEOUT_MS
    );
  } catch (error) {
    console.error("[Context7] Auth elicitation failed:", error);
    return "no-response";
  }

  if (result.action !== "accept") {
    bumpDecline(context, state);
    return result.action === "decline" ? "decline" : "cancel";
  }
  markPrompted(context, state);
  return "accept";
}

export async function runHttpFormElicitation({
  context,
  server,
  state,
}: ElicitContext): Promise<boolean> {
  let result;
  try {
    result = await sendElicitation(
      server,
      { mode: "form", message: PROMPT_MESSAGE, ...pickFormParams(context.clientInfo?.ide) },
      ELICIT_TIMEOUT_MS
    );
  } catch (error) {
    console.error("[Context7] Auth elicitation failed:", error);
    return false;
  }
  return await applyPromptChoice(result, { context, server, state });
}

/**
 * Process the response to a form-mode elicitation. Codex returns
 * `_meta.persist: "always"` when the user picks "Always allow", in which
 * case we sign in *and* opt out of future prompts.
 */
async function applyPromptChoice(
  result: ElicitResult,
  { context, state }: ElicitContext
): Promise<boolean> {
  const meta = (result as ElicitResult & { _meta?: ElicitResponseMeta })._meta;
  debug("elicit response", { action: result.action, persist: meta?.persist });

  if (result.action !== "accept") {
    bumpDecline(context, state);
    return false;
  }
  if (meta?.persist === "always") state.optedOut = true;

  runOAuthFlow({
    openInBrowser: true,
    clientName: context.clientInfo?.ide,
    serverOrigin: context.serverOrigin,
  });
  markPrompted(context, state);
  return true;
}
