/**
 * When a host web-search vendor is active, native `WebSearch` is disabled and
 * replaced by the in-container `mcp__web__web_search` tool (see claude-code.ts
 * disallowedTools / MCP registration). The system-prompt tool catalog must name
 * whichever tool the model actually has, so we swap the label to match.
 */
export function resolveWebSearchToolInPrompt(prompt: string, webSearchProvider: string | undefined): string {
  if (!webSearchProvider) return prompt
  return prompt.replace('`WebSearch`', '`mcp__web__web_search`')
}
