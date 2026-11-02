/**
 * Tools only the main conversation may call. A session wake resumes the main
 * conversation, and a session holds one pending wake: a subagent's
 * schedule_resume would replace the main agent's wake and never resume the
 * subagent.
 *
 * The container denies these inside a subagent in a PreToolUse hook. The host
 * sees the call on the subagent's stream either way, and fails it there
 * rather than running it.
 *
 * Import-free: the host imports it too.
 */
export const MAIN_THREAD_ONLY_TOOLS: ReadonlySet<string> = new Set(['mcp__user-input__schedule_resume'])

export const MAIN_THREAD_ONLY_TOOL_MESSAGE =
  'schedule_resume is only available to the main conversation, not to a subagent: a wake resumes the main conversation, never this subagent. Finish your task and report back; the main agent can pause the session itself.'
