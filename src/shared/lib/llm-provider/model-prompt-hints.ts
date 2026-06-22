export const GPT_TOOL_USE_PROMPT_HINTS = [
  'When tools are deferred, use ToolSearch before declaring a capability unavailable. For select: queries, use exact full tool names from the deferred-tools reminder, such as mcp__browser__browser_open, not shortened names like browser_open; keyword queries are also valid.',
  'Omit optional tool parameters you are not using — never send an empty value (empty string, empty array, empty object) in their place, as that counts as supplying the field and is often rejected. For example, with Read, omit pages or give a valid range like "1-5" and never send pages as an empty string; and when a tool accepts exactly one of two parameters (e.g. browser_run\'s command vs args), send only the one you use and omit the other rather than passing it as [].',
]
