import { EventSource } from 'eventsource'
import { EMAIL_GATEWAY_URL } from './config-schema'
import { emailBearer } from './gateway-client'

// One live subscription per Platform member, regardless of how many agents own mailboxes.
// SSE is a wake-up hint. Durable cursor polling remains the source of truth after reconnect.
type Listener = { mailboxId: string; wake: () => void }
type Group = { listeners: Map<string, Listener>; source?: EventSource; cursor: number }
const groups = new Map<string, Group>()
export function watchEmail(ownerUserId: string | null, memberId: string, integrationId: string, mailboxId: string, wake: () => void): () => void {
  const key = `${ownerUserId ?? 'local'}:${memberId}`
  const group: Group = groups.get(key) ?? { listeners: new Map(), cursor: 0 }
  groups.set(key, group)
  const reconnect = () => {
    group.source?.close()
    if (!group.listeners.size) { groups.delete(key); return }
    const ids = [...group.listeners.values()].map(listener => listener.mailboxId).slice(0, 20)
    group.source = new EventSource(`${EMAIL_GATEWAY_URL}/v1/events/stream?mailboxIds=${ids.join(',')}&after=${group.cursor}`, {
      fetch: async (input, init) => fetch(input, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await emailBearer(ownerUserId)}` }, redirect: 'error' }),
    })
    const hint = (event: MessageEvent) => {
      if (event.lastEventId) group.cursor = Math.max(group.cursor, Number(event.lastEventId) || 0)
      for (const listener of group.listeners.values()) listener.wake()
    }
    group.source.addEventListener('ready', hint)
    group.source.addEventListener('message.received', hint)
    group.source.addEventListener('thread.reconciled', hint)
  }
  group.listeners.set(integrationId, { mailboxId, wake })
  reconnect()
  return () => { group.listeners.delete(integrationId); reconnect() }
}
