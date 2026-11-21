import type { ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

/**
 * Which live run belongs to an Agent call: its own, or a later SendMessage
 * run of the same agent, which streams into the same row and tab.
 */
export function resolveSubagentRun(
  toolCall: ApiToolCall,
  activeSubagents: SubagentInfo[] | undefined,
  completedSubagents: Set<string> | null | undefined,
): { activeSubagent: SubagentInfo | null; isCompleted: boolean } {
  const directRun = activeSubagents?.find((sub) => sub.parentToolId === toolCall.id)
  const agentId = toolCall.subagent?.agentId
  const resumedRun = agentId
    ? activeSubagents?.find((sub) =>
      sub.agentId === agentId &&
      sub.parentToolId !== toolCall.id &&
      (!sub.parentToolId || !completedSubagents?.has(sub.parentToolId))
    )
    : undefined
  const activeSubagent = resumedRun ?? directRun ?? null
  const selectedToolId = activeSubagent?.parentToolId ?? toolCall.id
  return {
    activeSubagent,
    isCompleted: completedSubagents?.has(selectedToolId) ?? false,
  }
}
