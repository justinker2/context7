import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface ApplyResult {
  content: string;
  serversUpdated: string[];
}

type ConfigFormat = "toml" | "json" | "jsonc";

interface ClientConfigSpec {
  name: string;
  /** Substrings on `clientInfo.name` that identify this client. */
  match: string[];
  /** Candidate config paths, tried in order; first existing one is used. */
  paths: string[];
  format: ConfigFormat;
  /** Key under which MCP servers live (`"mcpServers"`, `"mcp_servers"`, `"mcp"`). */
  configKey: string;
  /** Field on each server entry holding the endpoint URL. */
  urlField: string;
}

function detectClient(clientName: string | undefined): ClientConfigSpec | null {
  if (!clientName) return null;
  const lower = clientName.toLowerCase();
  for (const spec of CLIENT_SPECS) {
    if (spec.match.some((needle) => lower.includes(needle))) return spec;
  }
  return null;
}

function firstExistingPath(paths: string[]): string | null {
  for (const p of paths) {
    try {
      fs.accessSync(p);
      return p;
    } catch {}
  }
  return null;
}

/**
 * Strip line and block comments from a JSONC source. Mirrors the helper in
 * the CLI's `mcp-writer.ts`; clients like Cursor and OpenCode allow comments
 * in their config files.
 */
function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      result += text.slice(start, ++i);
    } else if (text[i] === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += text[i++];
    }
  }
  return result;
}

function applyJsonConfig(
  spec: ClientConfigSpec,
  content: string,
  token: string,
  urlOrigin: string
): ApplyResult | null {
  const stripped = spec.format === "jsonc" ? stripJsonComments(content) : content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const root = parsed as Record<string, unknown>;
  const servers = root[spec.configKey];
  if (!servers || typeof servers !== "object") return null;

  const updated: string[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const url = entry[spec.urlField];
    if (typeof url !== "string" || !url.startsWith(urlOrigin)) continue;
    const headers = (entry.headers as Record<string, string> | undefined) ?? {};
    entry.headers = { ...headers, Authorization: `Bearer ${token}` };
    updated.push(name);
  }
  if (updated.length === 0) return null;

  const indent = detectJsonIndent(content);
  const trailingNewline = content.endsWith("\n") ? "\n" : "";
  return {
    content: JSON.stringify(parsed, null, indent) + trailingNewline,
    serversUpdated: updated,
  };
}

function detectJsonIndent(content: string): number | string {
  const m = /^([ \t]+)"/m.exec(content);
  if (!m) return 2;
  if (m[1].includes("\t")) return "\t";
  return Math.max(1, m[1].length);
}

function applyTomlConfig(content: string, token: string, urlOrigin: string): ApplyResult | null {
  const matches = findMatchingTomlServerNames(content, urlOrigin);
  if (matches.length === 0) return null;
  let updated = content;
  for (const name of matches) {
    updated = upsertCodexHttpHeaders(updated, name, token);
  }
  return { content: updated, serversUpdated: matches };
}

function findMatchingTomlServerNames(content: string, urlOrigin: string): string[] {
  const out: string[] = [];
  const headerRe = /^\[mcp_servers\.([^\].]+)\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    const bodyStart = m.index + m[0].length;
    const remainder = content.slice(bodyStart);
    const nextSection = /^\[/m.exec(remainder);
    const body = nextSection ? remainder.slice(0, nextSection.index) : remainder;
    if (urlMatchesToml(body, urlOrigin)) out.push(m[1]);
  }
  return out;
}

function urlMatchesToml(body: string, urlOrigin: string): boolean {
  const m = /url\s*=\s*["']([^"']+)["']/i.exec(body);
  return m ? m[1].startsWith(urlOrigin) : false;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert or replace `Authorization = "Bearer <token>"` under the
 * `[mcp_servers.<name>.http_headers]` sub-table, creating the sub-table if
 * it doesn't exist. Targeted regex edits preserve the user's existing TOML
 * formatting and adjacent entries.
 */
function upsertCodexHttpHeaders(content: string, sectionName: string, token: string): string {
  const escapedName = escapeForRegex(sectionName);
  const subTableHeaderRe = new RegExp(
    `^\\[mcp_servers\\.${escapedName}\\.http_headers\\]\\s*$`,
    "m"
  );
  const headerLine = `Authorization = "Bearer ${token}"`;

  if (subTableHeaderRe.test(content)) {
    const headerMatch = subTableHeaderRe.exec(content)!;
    const bodyStart = headerMatch.index + headerMatch[0].length;
    const remainder = content.slice(bodyStart);
    const nextSection = /^\[/m.exec(remainder);
    const bodyEnd = nextSection ? bodyStart + nextSection.index : content.length;
    const body = content.slice(bodyStart, bodyEnd);

    const existingAuthRe = /^Authorization\s*=\s*"[^"]*"\s*$/m;
    const newBody = existingAuthRe.test(body)
      ? body.replace(existingAuthRe, headerLine)
      : `\n${headerLine}` + body;
    return content.slice(0, bodyStart) + newBody + content.slice(bodyEnd);
  }

  const trailing = content.endsWith("\n") ? "" : "\n";
  return `${content}${trailing}\n[mcp_servers.${sectionName}.http_headers]\n${headerLine}\n`;
}

function applySpec(
  spec: ClientConfigSpec,
  content: string,
  token: string,
  urlOrigin: string
): ApplyResult | null {
  return spec.format === "toml"
    ? applyTomlConfig(content, token, urlOrigin)
    : applyJsonConfig(spec, content, token, urlOrigin);
}

function claudeGlobalPath(): string {
  // Mirror the CLI's behavior so `CLAUDE_CONFIG_DIR` overrides apply here too.
  if (process.env.CLAUDE_CONFIG_DIR) {
    return path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
  }
  return path.join(os.homedir(), ".claude.json");
}

const CLIENT_SPECS: ClientConfigSpec[] = [
  {
    name: "codex",
    match: ["codex"],
    paths: [path.join(os.homedir(), ".codex", "config.toml")],
    format: "toml",
    configKey: "mcp_servers",
    urlField: "url",
  },
  {
    name: "claude-code",
    match: ["claude-code", "claude_code"],
    paths: [claudeGlobalPath()],
    format: "json",
    configKey: "mcpServers",
    urlField: "url",
  },
  {
    name: "cursor",
    match: ["cursor"],
    paths: [path.join(os.homedir(), ".cursor", "mcp.json")],
    format: "jsonc",
    configKey: "mcpServers",
    urlField: "url",
  },
  {
    name: "opencode",
    match: ["opencode"],
    paths: [
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
      path.join(os.homedir(), ".config", "opencode", ".opencode.json"),
      path.join(os.homedir(), ".config", "opencode", ".opencode.jsonc"),
    ],
    format: "jsonc",
    configKey: "mcp",
    urlField: "url",
  },
  {
    name: "gemini",
    match: ["gemini"],
    paths: [path.join(os.homedir(), ".gemini", "settings.json")],
    format: "jsonc",
    configKey: "mcpServers",
    urlField: "httpUrl",
  },
];

interface UpdateResult {
  ok: boolean;
  reason?: string;
  configPath?: string;
  serversUpdated?: string[];
}

/**
 * Inject the bearer token into the MCP client's own config so future
 * requests carry `Authorization: Bearer <token>` automatically. Best-effort
 * and non-fatal — returns a result describing what happened.
 */
export function updateClientConfigAuth(
  clientName: string | undefined,
  urlOrigin: string,
  token: string
): UpdateResult {
  const spec = detectClient(clientName);
  if (!spec) return { ok: false, reason: `no config writer for client '${clientName ?? "?"}'` };

  const configPath = firstExistingPath(spec.paths);
  if (!configPath) {
    return { ok: false, reason: `no ${spec.name} config found at ${spec.paths.join(", ")}` };
  }

  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    return { ok: false, reason: `failed to read ${configPath}: ${(error as Error).message}` };
  }

  const result = applySpec(spec, content, token, urlOrigin);
  if (result === null) {
    return {
      ok: false,
      reason: `no mcp server entry in ${configPath} matches url ${urlOrigin}`,
    };
  }
  if (result.content === content) {
    return { ok: true, configPath, serversUpdated: result.serversUpdated };
  }

  const tmp = configPath + ".tmp";
  try {
    fs.writeFileSync(tmp, result.content, { mode: 0o600 });
    fs.renameSync(tmp, configPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, reason: `write failed: ${(error as Error).message}` };
  }

  return {
    ok: true,
    configPath,
    serversUpdated: result.serversUpdated,
  };
}
