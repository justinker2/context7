---
"@upstash/context7-mcp": minor
---

Prompt anonymous users to sign in. After the backend signals (via the `X-Context7-Auth-Prompt: 1` response header on `/v2/libs/search` or `/v2/context`) that an anonymous client has crossed the per-IP threshold, the MCP server surfaces a one-time sign-in invitation.

- **stdio** transport: native MCP `elicitation/create` (URL-mode when the client supports it, form-mode otherwise). On accept, the server completes OAuth via a `localhost:52417` callback and writes tokens to `~/.context7/credentials.json` (mode `0600`). The access token is refreshed transparently via `refresh_token` when it expires. The same long-running process picks up tokens on the next tool call — no client restart needed.
- **HTTP** transport: the server can't drive a browser on the user's machine, so it appends a tool-result notice asking the assistant to run `npx ctx7 setup --<client> --mcp -y` after explicit user confirmation. The CLI handles OAuth and writes the bearer into the client's MCP config.
- Detects the calling client from `X-Context7-Client-IDE` / User-Agent and selects the matching CLI flag (`--cursor`, `--claude`, `--codex`, `--opencode`, `--gemini`); falls back to interactive setup when unknown.
- HTTP transport remains stateless — the threshold is tracked by the backend (per-IP, 24h TTL), the MCP server only reacts to the signal.
