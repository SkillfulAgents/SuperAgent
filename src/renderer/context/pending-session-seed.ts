import type { PendingMessage } from '@renderer/components/messages/pending-message'

// Wizard/CreateAgentForm run outside AgentShell; the shell copies a seed during
// render and clears it only after that render commits.
const seeds = new Map<string, PendingMessage>()

export function seedPendingSessionMessage(
  sessionId: string,
  initialMessage: string,
  messageUuid: string,
  sender?: PendingMessage['sender'],
): void {
  seeds.set(sessionId, {
    localId: messageUuid,
    uuid: messageUuid,
    text: initialMessage,
    sentAt: Date.now(),
    sender,
  })
}

/** Read a seed without consuming it so render retries see the same value. */
export function peekPendingSessionSeed(sessionId: string): PendingMessage | undefined {
  return seeds.get(sessionId)
}

/** Clear a seed only after the AgentShell render that copied it has committed. */
export function clearPendingSessionSeed(sessionId: string): void {
  seeds.delete(sessionId)
}

/** Test-only: drop leftover seeds between cases. */
export function clearPendingSessionSeeds(): void {
  seeds.clear()
}
