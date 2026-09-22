import type { CollaborationEvent } from '@shared/lib/agent-members-schema'

type Listener = (event: CollaborationEvent) => void | Promise<void>
const listeners = new Map<string, Set<Listener>>()

/** One subscription per existing global SSE connection, keyed by verified user. */
export function subscribeCollaborationEvents(userId: string, listener: Listener): () => void {
  const clients = listeners.get(userId) ?? new Set<Listener>()
  clients.add(listener)
  listeners.set(userId, clients)
  return () => {
    clients.delete(listener)
    if (!clients.size) listeners.delete(userId)
  }
}

/** Recipients are resolved by the service at the mutation boundary. */
export function publishCollaborationEvent(userIds: Iterable<string>, event: CollaborationEvent): void {
  for (const userId of new Set(userIds)) {
    for (const listener of listeners.get(userId) ?? []) {
      try {
        Promise.resolve(listener(event)).catch((error) => console.error('Collaboration stream write failed:', error))
      } catch (error) {
        console.error('Collaboration stream write failed:', error)
      }
    }
  }
}
