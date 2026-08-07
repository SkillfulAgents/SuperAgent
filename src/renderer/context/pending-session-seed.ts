import type { PendingMessage } from '@renderer/components/messages/pending-message'

// Wizard/CreateAgentForm run outside AgentShell; shell drains this on first read.
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

/** Take and clear a seed written before AgentShell mounted. */
export function takePendingSessionSeed(sessionId: string): PendingMessage | undefined {
  const seeded = seeds.get(sessionId)
  if (!seeded) return undefined
  seeds.delete(sessionId)
  return seeded
}

/** Test-only: drop leftover seeds between cases. */
export function clearPendingSessionSeeds(): void {
  seeds.clear()
}
