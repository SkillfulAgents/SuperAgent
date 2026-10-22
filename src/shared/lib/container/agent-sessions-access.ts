import type { CoalescedUserMessage } from './runtime-death'
import type { ContainerClient } from './types'

/**
 * What a container runtime needs from its agent's live sessions. The sessions
 * live on the agent's actor; the runtime marks them when the container stops,
 * asks whether any is busy before putting it to sleep, and drives them through
 * recovery when it dies mid-turn.
 */
export interface RuntimeSessions {
  /** Mark the mid-turn sessions (only these, when given) recovering, and return them. */
  claimMidTurnForRecovery(restrictToSessionIds?: string[]): string[]
  /** Recovery gave up on these: they end their turn with an error. */
  settleRecovering(sessionIds: string[]): void
  /** Recovery resumed these: their turn carries on. */
  markRecovered(sessionIds: string[]): void
  /** Close the requests a recovered session's dead turn left open. */
  supersedeRequests(sessionId: string): void
  /** The user messages sent while the session was recovering, taken for redelivery. */
  takeCoalesced(sessionId: string): CoalescedUserMessage[]
  isRecovering(sessionId: string): boolean
  isSubscribed(sessionId: string): boolean
  subscribe(sessionId: string, client: ContainerClient, containerSessionId: string): Promise<void>
  /** Run `work` in the session's delivery turn (see `LiveSessions.inDeliveryTurn`). */
  inDeliveryTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T>
  /** The container is gone: no session is running. */
  markAllInactive(options?: { settleRecovering?: boolean }): void
  hasActive(): boolean
  hasAwaitingInput(): boolean
}

/**
 * The way from the container layer to the agents' live sessions. Attached to
 * the container host by the agent registry when it is created, like
 * `AgentWorkspaceAccess`.
 */
export interface AgentSessionsAccess {
  /** The agent's live sessions, when its actor is held. An agent with none has nothing live. */
  peek(slug: string): RuntimeSessions | undefined
}

/** The sessions of an agent that has none live. */
export const NO_LIVE_SESSIONS: RuntimeSessions = {
  claimMidTurnForRecovery: () => [],
  settleRecovering: () => {},
  markRecovered: () => {},
  supersedeRequests: () => {},
  takeCoalesced: () => [],
  isRecovering: () => false,
  isSubscribed: () => false,
  subscribe: async () => {},
  inDeliveryTurn: (_sessionId, work) => work(),
  markAllInactive: () => {},
  hasActive: () => false,
  hasAwaitingInput: () => false,
}
