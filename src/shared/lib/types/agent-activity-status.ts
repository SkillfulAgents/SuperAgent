import type { ContainerStatus } from '../container/types'
import type { ApiAgent } from './api'

export type AgentActivityStatus = 'sleeping' | 'idle' | 'working' | 'awaiting_input'

type ActivityFlags = Pick<ApiAgent, 'hasSessionsAwaitingInput' | 'hasActiveSessions'>
type SessionActivity = readonly { isAwaitingInput?: boolean; isActive?: boolean }[]

/** Combine loaded session activity with the agent summary; awaiting input wins. */
export function agentActivity(agent: ActivityFlags, sessions?: SessionActivity) {
  const isAwaiting = sessions?.some(s => s.isAwaitingInput) || (agent.hasSessionsAwaitingInput ?? false)
  const isWorking = !isAwaiting && (sessions?.some(s => s.isActive) || (agent.hasActiveSessions ?? false))
  return { isAwaiting, isWorking }
}

export function getAgentActivityStatus(
  containerStatus: ContainerStatus,
  hasActiveSessions: boolean,
  hasSessionsAwaitingInput: boolean = false
): AgentActivityStatus {
  if (containerStatus === 'stopped') return 'sleeping'
  const { isAwaiting, isWorking } = agentActivity({ hasActiveSessions, hasSessionsAwaitingInput })
  if (isAwaiting) return 'awaiting_input'
  if (isWorking) return 'working'
  return 'idle'
}

/**
 * Avatars retain their attention-first presentation: pending input, work and
 * unread results precede sleep. The runtime status indicator above retains
 * its stopped-first policy. Keep those presentation policies explicit here.
 */
export function agentAvatarState(
  agent: ActivityFlags & Pick<ApiAgent, 'hasUnreadNotifications' | 'status'>,
  sessions?: SessionActivity,
) {
  const { isAwaiting, isWorking } = agentActivity(agent, sessions)
  if (isAwaiting) return 'needs-input'
  if (isWorking) return 'working'
  if (agent.hasUnreadNotifications) return 'done'
  if (agent.status === 'stopped') return 'sleeping'
  return 'idle'
}
