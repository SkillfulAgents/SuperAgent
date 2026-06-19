export const GPT_TOOL_USE_PROMPT_HINTS = [
  'When tools are deferred, use ToolSearch before declaring a capability unavailable. For select: queries, use exact full tool names from the deferred-tools reminder, such as mcp__browser__browser_open, not shortened names like browser_open; keyword queries are also valid.',
  'For the Read tool, omit optional parameters you do not need. In particular, do not send pages as an empty string; either omit pages or use a valid range like "1" or "1-5".',
]
