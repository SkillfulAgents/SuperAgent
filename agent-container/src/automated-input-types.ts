/**
 * The user-input MCP tools the HOST answers programmatically — its
 * message-persister handlers hit the DB/scheduler and push the answer back
 * within milliseconds, so no human is ever waiting on one.
 *
 * Single source for both sides: the container derives the pending-input TTL
 * from it (input-manager) and the subagent deny list (claude-code); the host
 * derives its handler table and recovery predicate from it
 * (src/shared/lib/container/automated-tools.ts). A tool present on one side
 * and not the other is a typecheck error there, not a 24-hour park.
 *
 * Keep this file import-free: the host bundles it too.
 */
export const AUTOMATED_INPUT_TYPES = [
  'schedule_task',
  'schedule_resume',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  'pause_scheduled_task',
  'resume_scheduled_task',
  'create_webhook_endpoint',
  'update_webhook_endpoint',
  'inspect_webhook_events',
  'list_triggers',
  'get_available_triggers',
  'setup_trigger',
  'cancel_trigger',
] as const

export type AutomatedInputType = (typeof AUTOMATED_INPUT_TYPES)[number]

/**
 * Automated tools only the main thread may call. A session wake resumes the
 * main conversation and a session holds one pending wake, so a subagent
 * calling schedule_resume would replace the main agent's wake and never itself
 * resume. The container denies these in a PreToolUse hook; the host rejects
 * them on its subagent delivery roads as a backstop.
 */
export const MAIN_THREAD_ONLY_INPUT_TYPES = ['schedule_resume'] as const satisfies readonly AutomatedInputType[]

export const MAIN_THREAD_ONLY_TOOL_MESSAGE =
  'schedule_resume is only available to the main session, not to subagents: a wake resumes the main conversation, not this subagent. Finish your task and report back; the main agent can pause the session itself.'

export const USER_INPUT_TOOL_PREFIX = 'mcp__user-input__'

/** The tool name the model calls for a user-input MCP input type. */
export function userInputToolName<T extends string>(inputType: T): `${typeof USER_INPUT_TOOL_PREFIX}${T}` {
  return `${USER_INPUT_TOOL_PREFIX}${inputType}`
}
