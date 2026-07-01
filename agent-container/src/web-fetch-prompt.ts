/**
 * When a host web-fetch vendor is active, native `WebFetch` is disabled and replaced by the
 * in-container `mcp__web__web_fetch` tool (see claude-code.ts disallowedTools / MCP registration).
 * The system-prompt tool catalog must name whichever tool the model actually has, so we swap the
 * label to match.
 */
export function resolveWebFetchToolInPrompt(prompt: string, webFetchProvider: string | undefined): string {
  if (!webFetchProvider) return prompt
  return prompt.replace('`WebFetch`', '`mcp__web__web_fetch`')
}
