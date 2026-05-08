import * as crypto from "crypto";
import * as http from "http";
import * as fs from "fs";
import { spawn } from "child_process";
import { CREDENTIALS_FILE, ensureConfigDir, envInt } from "./state.js";
import { updateClientConfigAuth } from "../client-config.js";

const CLI_CLIENT_ID = "2veBSofhicRBguUT";
const CALLBACK_PORT = 52417;
const CONTEXT7_BASE_URL = process.env.CONTEXT7_AUTH_BASE_URL || "https://context7.com";
const OAUTH_CALLBACK_TIMEOUT_MS = envInt("CONTEXT7_OAUTH_TIMEOUT_MS", 5 * 60 * 1000);

interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
}

/** Reads the OAuth credentials file shared with the `ctx7` CLI. */
export function loadStdioToken(): string | undefined {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    const tokens = JSON.parse(raw) as TokenData;
    if (!tokens.access_token) return undefined;
    if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) return undefined;
    return tokens.access_token;
  } catch {
    return undefined;
  }
}

function saveStdioToken(tokens: TokenData): void {
  ensureConfigDir();
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
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    console.error("[Context7] Failed to open browser:", error);
  }
}

interface CallbackResult {
  code: string;
  state: string;
}

function awaitOAuthCallback(expectedState: string, timeoutMs: number): Promise<CallbackResult> {
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

      res.end(
        simplePage("Sign-in successful", "You can close this window and return to your editor.")
      );
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

function simplePage(title: string, message: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><title>${escape(title)}</title></head><body style="font-family: system-ui; padding: 3rem; text-align: center;"><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
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

const DEBUG = process.env.CONTEXT7_AUTH_PROMPT_DEBUG === "1";

export interface OAuthFlowOptions {
  /** When true, open the URL in the user's browser (form-mode acceptance,
   *  where the client never sees the URL itself). When false, the elicit
   *  client opens it (URL-mode acceptance). */
  openInBrowser: boolean;
  /** `clientInfo.name` from the MCP initialize handshake. Used to update the
   *  matching MCP client config with the bearer token after sign-in. */
  clientName?: string;
  /** Server origin (`scheme://host[:port]`) the client used. */
  serverOrigin?: string;
}

/** A pending OAuth flow: callback already listening on CALLBACK_PORT. We
 *  reuse it across concurrent prompts so we don't double-bind the port. */
let activeFlow: { url: string; expiresAt: number } | null = null;

/**
 * Start (or reuse) an OAuth handshake: spin up the localhost callback, run
 * code exchange in the background, persist tokens to
 * `~/.context7/credentials.json`, and (when we know the calling MCP client)
 * inject the bearer token into that client's config. Returns the
 * authorization URL. Subsequent calls within the callback's lifetime return
 * the same URL instead of starting a new flow.
 */
export function runOAuthFlow({
  openInBrowser,
  clientName,
  serverOrigin,
}: OAuthFlowOptions): string {
  if (activeFlow && activeFlow.expiresAt > Date.now()) {
    if (openInBrowser) openBrowser(activeFlow.url);
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

      if (!clientName || !serverOrigin || !tokens.access_token) return;
      const result = updateClientConfigAuth(clientName, serverOrigin, tokens.access_token);
      if (result.ok) {
        const entries = result.serversUpdated?.length
          ? ` (entries: ${result.serversUpdated.join(", ")})`
          : "";
        console.error(
          `[Context7] Updated ${clientName} config at ${result.configPath}${entries}. Restart your MCP client to pick up the new credentials.`
        );
      } else if (DEBUG) {
        console.error(
          `[Context7:auth-prompt] Skipped ${clientName} config update: ${result.reason}`
        );
      }
    })
    .catch((error) => {
      console.error("[Context7] OAuth callback failed:", error);
    })
    .finally(() => {
      activeFlow = null;
    });

  if (openInBrowser) openBrowser(url);
  return url;
}
