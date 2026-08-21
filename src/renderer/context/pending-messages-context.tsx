import { createContext, useContext } from 'react'
import type { PendingMessage } from '@renderer/components/messages/pending-message'
import type { SessionUsage } from '@shared/lib/types/agent'

/**
 * Provided by AgentShell (the `/agents/$slug` layout route): the optimistic
 * pending-message store + the live stream's context usage. AgentShell holds
 * `pendingMessagesRef` and `useMessageStream` (holder #1) so they survive across
 * the agent's sub-views; the agent body consumes them here instead of owning
 * them.
 */
export interface PendingMessagesContextValue {
  getPendingMessages: (sessionId: string | null) => PendingMessage[]
  onMessageSent: (content: string, localId: string, queued: boolean) => void
  onMessageUuidAssigned: (localId: string, uuid: string, queued: boolean) => void
  onPendingMessageAppeared: (localId: string) => void
  onSessionCreated: (sessionId: string, initialMessage: string, messageUuid: string) => void
  clearPendingMessagesForSession: (sessionId: string) => void
  streamContextUsage: SessionUsage | null
}

const PendingMessagesContext = createContext<PendingMessagesContextValue | null>(null)

export const PendingMessagesProvider = PendingMessagesContext.Provider

export function usePendingMessages(): PendingMessagesContextValue {
  const ctx = useContext(PendingMessagesContext)
  if (!ctx) throw new Error('usePendingMessages must be used within an AgentShell')
  return ctx
}
