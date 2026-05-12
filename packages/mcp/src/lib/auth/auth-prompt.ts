const PROMPT_AFTER_CALLS = (() => {
  const raw = parseInt(process.env.CONTEXT7_PROMPT_AFTER_CALLS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
})();
const FORCE_PROMPT = process.env.CONTEXT7_FORCE_PROMPT === "1";

interface PromptState {
  count: number;
  fired: boolean;
}

const stateByKey = new Map<string, PromptState>();

export function forgetPromptState(key: string): void {
  stateByKey.delete(key);
}

export function recordCallAndDecide(stateKey: string, hasAuth: boolean): boolean {
  if (hasAuth) return false;
  const s = stateByKey.get(stateKey) ?? { count: 0, fired: false };
  s.count += 1;
  stateByKey.set(stateKey, s);
  if (s.fired) return false;
  const threshold = FORCE_PROMPT ? 1 : PROMPT_AFTER_CALLS;
  if (s.count < threshold) return false;
  s.fired = true;
  return true;
}

export function clientFlagForCli(ide: string | undefined): string {
  if (!ide) return "";
  const lower = ide.toLowerCase();
  if (lower.includes("cursor")) return "--cursor";
  if (lower.includes("claude")) return "--claude";
  if (lower.includes("codex")) return "--codex";
  if (lower.includes("opencode")) return "--opencode";
  if (lower.includes("gemini")) return "--gemini";
  return "";
}

export interface BuildAuthPromptOptions {
  clientIde?: string;
  rateLimited?: boolean;
}

export function buildAuthPrompt(opts: BuildAuthPromptOptions): string {
  const flag = clientFlagForCli(opts.clientIde);
  const command = flag ? `npx ctx7 setup ${flag} --mcp -y` : `npx ctx7 setup --mcp`;
  const tag = opts.rateLimited ? "[Rate limit reached]" : "[Heads up]";
  const reason = opts.rateLimited
    ? "Context7's free anonymous rate limit was just hit."
    : "This user is using Context7 anonymously.";

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
