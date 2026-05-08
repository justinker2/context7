import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ClientContext } from "../encryption.js";

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const PROMPT_AFTER_CALLS = envInt("CONTEXT7_PROMPT_AFTER_CALLS", 5);
export const PROMPT_COOLDOWN_MS = envInt("CONTEXT7_PROMPT_COOLDOWN_MS", 7 * 24 * 60 * 60 * 1000);
export const MAX_DISMISSALS = envInt("CONTEXT7_PROMPT_MAX_DISMISSALS", 3);
const FINGERPRINT_TTL_MS = 24 * 60 * 60 * 1000;

export const CONFIG_DIR = process.env.CONTEXT7_CONFIG_DIR || path.join(os.homedir(), ".context7");
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");
const PROMPT_STATE_FILE = path.join(CONFIG_DIR, "mcp-prompt-state.json");

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export interface PromptState {
  count: number;
  lastPromptedAt: number;
  dismissCount: number;
  optedOut: boolean;
  updatedAt: number;
}

export function emptyState(): PromptState {
  return {
    count: 0,
    lastPromptedAt: 0,
    dismissCount: 0,
    optedOut: false,
    updatedAt: Date.now(),
  };
}

const httpStates = new Map<string, PromptState>();
let stdioState: PromptState | null = null;

function isPromptingDisabled(): boolean {
  const flag = process.env.CONTEXT7_DISABLE_AUTH_PROMPT;
  return flag === "1" || flag === "true";
}

/** Test-only: bypass all rate-limiting/opt-out so the prompt fires on every
 *  unauthenticated call. Useful to iterate on the UX without resetting state. */
export function isForcePrompt(): boolean {
  const flag = process.env.CONTEXT7_FORCE_PROMPT;
  return flag === "1" || flag === "true";
}

function fingerprint(context: ClientContext): string {
  const ide = context.clientInfo?.ide ?? "unknown";
  const ip = context.clientIp ?? "unknown";
  return `${ide}:${ip}`;
}

function pruneHttpStates(): void {
  const cutoff = Date.now() - FINGERPRINT_TTL_MS;
  for (const [key, state] of httpStates) {
    if (state.updatedAt < cutoff && !state.optedOut) httpStates.delete(key);
  }
}

function loadStdioState(): PromptState {
  if (stdioState) return stdioState;
  try {
    const raw = fs.readFileSync(PROMPT_STATE_FILE, "utf-8");
    stdioState = JSON.parse(raw) as PromptState;
  } catch {
    stdioState = emptyState();
  }
  return stdioState;
}

function saveStdioState(state: PromptState): void {
  try {
    ensureConfigDir();
    fs.writeFileSync(PROMPT_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("[Context7] Failed to persist prompt state:", error);
  }
}

export function getState(context: ClientContext): PromptState {
  if (context.transport === "stdio") return loadStdioState();
  pruneHttpStates();
  const key = fingerprint(context);
  let state = httpStates.get(key);
  if (!state) {
    state = emptyState();
    httpStates.set(key, state);
  }
  return state;
}

export function persistState(context: ClientContext, state: PromptState): void {
  state.updatedAt = Date.now();
  if (context.transport === "stdio") {
    stdioState = state;
    saveStdioState(state);
  } else {
    httpStates.set(fingerprint(context), state);
  }
}

export function bumpDecline(context: ClientContext, state: PromptState): void {
  if (isForcePrompt()) return;
  state.lastPromptedAt = Date.now();
  state.dismissCount += 1;
  state.count = 0;
  if (state.dismissCount >= MAX_DISMISSALS) state.optedOut = true;
  persistState(context, state);
}

export function markPrompted(context: ClientContext, state: PromptState): void {
  if (isForcePrompt()) return;
  state.lastPromptedAt = Date.now();
  state.count = 0;
  persistState(context, state);
}

export function isAuthenticated(context: ClientContext): boolean {
  if (context.apiKey) return true;
  if (context.transport === "stdio") return Boolean(loadStdioTokenFromFile());
  return false;
}

/**
 * Read the access token from the credentials file. Duplicated here (rather
 * than importing from `oauth.ts`) to keep `state.ts` free of OAuth deps so
 * `isAuthenticated` can be called from anywhere without pulling in the rest
 * of the auth module.
 */
function loadStdioTokenFromFile(): string | undefined {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    const tokens = JSON.parse(raw) as { access_token?: string; expires_at?: number };
    if (!tokens.access_token) return undefined;
    if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) return undefined;
    return tokens.access_token;
  } catch {
    return undefined;
  }
}

export interface ShouldPromptResult {
  shouldPrompt: boolean;
}

export function recordCallAndDecide(context: ClientContext): ShouldPromptResult {
  if (isPromptingDisabled()) return { shouldPrompt: false };
  if (isForcePrompt()) return { shouldPrompt: true };
  if (isAuthenticated(context)) return { shouldPrompt: false };

  const state = getState(context);
  state.count += 1;

  if (state.optedOut) {
    persistState(context, state);
    return { shouldPrompt: false };
  }
  if (state.lastPromptedAt > 0 && Date.now() - state.lastPromptedAt < PROMPT_COOLDOWN_MS) {
    persistState(context, state);
    return { shouldPrompt: false };
  }
  if (state.count < PROMPT_AFTER_CALLS) {
    persistState(context, state);
    return { shouldPrompt: false };
  }

  persistState(context, state);
  return { shouldPrompt: true };
}

export const __testInternals = {
  reset(): void {
    httpStates.clear();
    stdioState = null;
  },
  setStdioState(s: PromptState | null): void {
    stdioState = s;
  },
  getStdioState(): PromptState | null {
    return stdioState;
  },
};
