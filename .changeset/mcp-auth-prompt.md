---
"@upstash/context7-mcp": minor
---

Prompt anonymous users to sign in. After several anonymous tool calls per session, the server surfaces a one-time sign-in invitation.

- **stdio** transport: the server sends a native MCP `elicitation/create` (URL-mode when the client supports it, form-mode otherwise). On accept, the OAuth flow completes via a `localhost:52417` callback and tokens are written to `~/.context7/credentials.json` with mode `0600`. The same long-running process picks up the token on the next tool call — no client restart needed.
- **HTTP** transport: the server can't drive a browser on the user's machine, so it appends a tool-result notice asking the assistant to run `npx ctx7 setup --<client> --mcp -y` after explicit user confirmation. The CLI handles OAuth and writes the bearer into the client's MCP config.
- Detects the calling client from the MCP `initialize` handshake and selects the matching CLI flag (`--cursor`, `--claude`, `--codex`, `--opencode`, `--gemini`); falls back to interactive setup when unknown.
- Threshold is configurable via `CONTEXT7_PROMPT_AFTER_CALLS` (default 5); `CONTEXT7_FORCE_PROMPT=1` fires on the first call for testing.
- HTTP transport is now stateful (per-session counter); stale `Mcp-Session-Id` returns 404 per MCP spec so clients silently re-init after a server restart.
