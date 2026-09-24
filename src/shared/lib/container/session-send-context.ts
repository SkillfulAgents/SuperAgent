import { AsyncLocalStorage } from 'node:async_hooks'

// Internal follow-ups share the interactive queue rule: an already-running
// turn keeps its selected account, even if credentials/defaults changed.
const delivery = new AsyncLocalStorage<{ agentSlug: string; sessionId: string; queued: boolean }>()
export function withSessionSendContext<T>(
  agentSlug: string,
  sessionId: string,
  queued: boolean,
  send: () => Promise<T>
): Promise<T> {
  return delivery.run({ agentSlug, sessionId, queued }, send)
}
export function isQueuedSessionSend(agentSlug: string, sessionId: string): boolean {
  const current = delivery.getStore()
  return !!current?.queued && current.agentSlug === agentSlug && current.sessionId === sessionId
}
