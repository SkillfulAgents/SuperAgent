// Single implementation lives in the agent-container tree (its Docker build
// context cannot reach files outside agent-container/, so sharing must point
// this way). The container derives its pending-input TTL and subagent deny
// list from the same list; the persister derives its handler table and the
// transcript-recovery predicate from these.
import {
  AUTOMATED_INPUT_TYPES,
  MAIN_THREAD_ONLY_INPUT_TYPES,
  userInputToolName,
} from '../../../../agent-container/src/automated-input-types'

export {
  MAIN_THREAD_ONLY_TOOL_MESSAGE,
  USER_INPUT_TOOL_PREFIX,
  userInputToolName,
  type AutomatedInputType,
} from '../../../../agent-container/src/automated-input-types'

export const AUTOMATED_TOOL_NAMES: ReadonlySet<string> = new Set(
  AUTOMATED_INPUT_TYPES.map((type) => userInputToolName(type)),
)

export const MAIN_THREAD_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  MAIN_THREAD_ONLY_INPUT_TYPES.map((type) => userInputToolName(type)),
)

/** A user-input tool the host answers itself, with no card and no human. */
export function isAutomatedToolName(toolName: string): boolean {
  return AUTOMATED_TOOL_NAMES.has(toolName)
}
