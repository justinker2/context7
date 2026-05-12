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
