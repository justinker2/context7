import * as crypto from "crypto";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

const CLI_CLIENT_ID = "2veBSofhicRBguUT";
const CALLBACK_PORT = 52417;
const CONTEXT7_BASE_URL = "https://context7.com";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const ELICIT_TIMEOUT_MS = 2 * 60 * 1000;

const CONFIG_DIR = path.join(homedir(), ".context7");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
}

function readTokens(): TokenData | undefined {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    const tokens = JSON.parse(raw) as TokenData;
    return tokens.access_token ? tokens : undefined;
  } catch {
    return undefined;
  }
}

function isExpired(tokens: TokenData): boolean {
  return Boolean(tokens.expires_at && Date.now() > tokens.expires_at - 60_000);
}

/**
 * Returns the current access token, refreshing via `refresh_token` if it's
 * expired (or near expiry). Returns undefined when no creds exist or
 * refresh fails — caller treats that as anonymous.
 */
export async function loadStdioToken(): Promise<string | undefined> {
  const tokens = readTokens();
  if (!tokens) return undefined;
  if (!isExpired(tokens)) return tokens.access_token;
  if (!tokens.refresh_token) return undefined;
  try {
    const fresh = await refreshAccessToken(tokens.refresh_token);
    if (!fresh.access_token) throw new Error("refresh response missing access_token");
    // Preserve the existing refresh_token if the provider didn't rotate
    // (some OAuth servers omit `refresh_token` on the refresh response and
    // expect the caller to keep using the original).
    saveStdioToken({
      ...fresh,
      refresh_token: fresh.refresh_token ?? tokens.refresh_token,
    });
    return fresh.access_token;
  } catch (err) {
    console.error("[Context7] Token refresh failed:", err);
    return undefined;
  }
}

function saveStdioToken(tokens: TokenData): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const data: TokenData = {
    ...tokens,
    expires_at:
      tokens.expires_at ?? (tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined),
  };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function buildAuthorizationUrl(redirectUri: string, codeChallenge: string, state: string): string {
  const url = new URL(`${CONTEXT7_BASE_URL}/api/oauth/authorize`);
  url.searchParams.set("client_id", CLI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "profile email");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("source", "mcp-elicitation");
  return url.toString();
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // spawn errors (e.g. xdg-open missing on a headless box) arrive async,
    // not via the synchronous try/catch.
    child.on("error", (error) => console.error("[Context7] Failed to open browser:", error));
    child.unref();
  } catch (error) {
    console.error("[Context7] Failed to open browser:", error);
  }
}

function simplePage(title: string, message: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><title>${escape(title)}</title></head><body style="font-family: system-ui; padding: 3rem; text-align: center;"><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
}

function awaitOAuthCallback(
  expectedState: string,
  timeoutMs: number
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end(simplePage("Sign-in failed", url.searchParams.get("error_description") || error));
        cleanup();
        reject(new Error(error));
        return;
      }
      if (!code || !state || state !== expectedState) {
        res.end(simplePage("Sign-in failed", "Missing or mismatched authorization parameters."));
        cleanup();
        reject(new Error("Invalid OAuth callback"));
        return;
      }
      res.end(simplePage("Sign-in successful", "You can close this window."));
      cleanup();
      resolve({ code, state });
    });
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timed out"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }
    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<TokenData> {
  const response = await fetch(`${CONTEXT7_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLI_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    throw new Error(
      body.error_description || body.error || `Token exchange failed (${response.status})`
    );
  }
  return (await response.json()) as TokenData;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const response = await fetch(`${CONTEXT7_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLI_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    throw new Error(
      body.error_description || body.error || `Token refresh failed (${response.status})`
    );
  }
  return (await response.json()) as TokenData;
}

// Reused across concurrent prompts so we don't double-bind the callback port.
let activeFlow: { url: string; expiresAt: number } | null = null;

/** Returns the authorize URL immediately; the callback listener and token
 *  exchange complete in the background. */
export function startOAuthFlow(opts: { openInBrowser: boolean }): string {
  if (activeFlow && activeFlow.expiresAt > Date.now()) {
    if (opts.openInBrowser) openBrowser(activeFlow.url);
    return activeFlow.url;
  }

  const { codeVerifier, codeChallenge } = generatePKCE();
  const oauthState = crypto.randomBytes(16).toString("base64url");
  const redirectUri = `http://localhost:${CALLBACK_PORT}/callback`;
  const url = buildAuthorizationUrl(redirectUri, codeChallenge, oauthState);
  activeFlow = { url, expiresAt: Date.now() + OAUTH_CALLBACK_TIMEOUT_MS };

  void awaitOAuthCallback(oauthState, OAUTH_CALLBACK_TIMEOUT_MS)
    .then(async ({ code }) => {
      const tokens = await exchangeCode(code, codeVerifier, redirectUri);
      saveStdioToken(tokens);
      console.error("[Context7] Sign-in successful. Tokens stored at", CREDENTIALS_FILE);
    })
    .catch((error) => {
      console.error("[Context7] OAuth flow failed:", error);
    })
    .finally(() => {
      activeFlow = null;
    });

  if (opts.openInBrowser) openBrowser(url);
  return url;
}

const ElicitResult = z.object({
  action: z.enum(["accept", "reject", "cancel", "decline"]),
});
type ElicitOutcome = "accept" | "decline" | "no-response";

const PROMPT_MESSAGE =
  "Sign in to Context7 for higher rate limits. Accept to open the sign-in page in your browser.";

function clientElicitCaps(server: Server): { form: boolean; url: boolean } {
  const caps = server.getClientCapabilities();
  const elicit = caps?.elicitation as { form?: object; url?: object } | undefined;
  if (!elicit) return { form: false, url: false };
  // Per MCP spec: an empty `elicitation: {}` means form-mode-only.
  const explicit = "form" in elicit || "url" in elicit;
  return {
    form: explicit ? Boolean(elicit.form) : true,
    url: explicit ? Boolean(elicit.url) : false,
  };
}

async function trySendUrlElicit(server: Server, url: string): Promise<ElicitOutcome> {
  try {
    const result = await server.request(
      {
        method: "elicitation/create",
        params: {
          mode: "url",
          message: PROMPT_MESSAGE,
          url,
          elicitationId: crypto.randomUUID(),
        },
      },
      ElicitResult,
      { timeout: ELICIT_TIMEOUT_MS }
    );
    return result.action === "accept" ? "accept" : "decline";
  } catch {
    return "no-response";
  }
}

async function tryFormElicit(server: Server): Promise<ElicitOutcome> {
  try {
    const result = await server.request(
      {
        method: "elicitation/create",
        params: {
          message: PROMPT_MESSAGE,
          requestedSchema: { type: "object", properties: {} },
        },
      },
      ElicitResult,
      { timeout: ELICIT_TIMEOUT_MS }
    );
    if (result.action === "accept") {
      // Form mode only returns yes/no — open the browser server-side.
      startOAuthFlow({ openInBrowser: true });
      return "accept";
    }
    return "decline";
  } catch {
    return "no-response";
  }
}

/** URL-mode first (client opens the URL itself), form-mode fallback
 *  (server opens the browser on accept), `no-response` if neither works. */
export async function tryElicitSignIn(server: Server): Promise<ElicitOutcome> {
  const caps = clientElicitCaps(server);

  if (caps.url) {
    const url = startOAuthFlow({ openInBrowser: false });
    const outcome = await trySendUrlElicit(server, url);
    if (outcome !== "no-response") return outcome;
  }
  if (caps.form) {
    return await tryFormElicit(server);
  }
  return "no-response";
}
