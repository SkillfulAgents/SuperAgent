import type { ContainerStatus } from '../container/types'

export type AgentActivityStatus = 'sleeping' | 'idle' | 'working' | 'awaiting_input'

export function getAgentActivityStatus(
  containerStatus: ContainerStatus,
  hasActiveSessions: boolean,
  hasSessionsAwaitingInput: boolean = false
): AgentActivityStatus {
  if (containerStatus === 'stopped') return 'sleeping'
  if (hasSessionsAwaitingInput) return 'awaiting_input'
  if (hasActiveSessions) return 'working'
  return 'idle'
}
