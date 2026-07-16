export const GPT_TOOL_USE_PROMPT_HINTS = [
  'When tools are deferred, use ToolSearch before declaring a capability unavailable. For select: queries, use exact full tool names from the deferred-tools reminder, such as mcp__browser__browser_open, not shortened names like browser_open; keyword queries are also valid.',
  'Omit optional tool parameters you are not using — never send an empty value (empty string, empty array, empty object) in their place, as that counts as supplying the field and is often rejected. For example, with Read, omit pages or give a valid range like "1-5" and never send pages as an empty string; and when a tool accepts exactly one of two parameters (e.g. browser_run\'s command vs args), send only the one you use and omit the other rather than passing it as [].',
]

export const GROK_BROWSER_TOOL_PROMPT_HINTS = [
  'For browser or website tasks, use the dedicated mcp__browser__browser_* tools instead of Bash or the agent-browser CLI. Start with mcp__browser__browser_open; for multi-step interactions, delegate to the web-browser agent after opening the browser. Only use agent-browser through Bash when the dedicated browser integration genuinely cannot perform the operation.',
  'When browser tools are deferred, use ToolSearch with exact full names from the deferred-tools reminder, such as select:mcp__browser__browser_open,mcp__browser__browser_close, not shortened names such as browser_open. A failed search for a shortened name does not mean the browser integration is unavailable.',
]
