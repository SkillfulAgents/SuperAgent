import { EventSource } from 'eventsource'
import { z } from 'zod'
import { appState } from '../app-state'
import { background } from '../background'
import { EMAIL_GATEWAY_URL } from './config-schema'
import { emailBearer } from './gateway-client'
import { EMAIL_WAKE_KINDS, emailMailboxWake, type EmailMailboxWake } from './wake'

// One live stream per Platform member, however many of its mailboxes this
// process watches. The stream is a source of wake hints only: each event goes
// out on its mailbox's wake channel (wake.ts), and that mailbox's connection
// polls from its durable cursor, which stays the source of truth. The
// EventSource and its resume point stay in this process, with the connections
// that opened it; the resume point is advisory and starts over on restart.
type Stream = { mailboxes: Map<string, string>; source?: EventSource; cursor: number }
const streams = new Map<string, Stream>()

/** The part of a stream event that names its mailbox. */
const streamEventSchema = z.object({ mailboxId: z.string() }).loose()

/** Opens or joins the member's stream for this mailbox; the returned function leaves it. */
export function watchEmail(ownerUserId: string | null, memberId: string, integrationId: string, mailboxId: string): () => void {
  const key = `${ownerUserId ?? 'local'}:${memberId}`
  const stream: Stream = streams.get(key) ?? { mailboxes: new Map(), cursor: 0 }
  streams.set(key, stream)
  const reconnect = () => {
    stream.source?.close()
    stream.source = undefined
    if (!stream.mailboxes.size) {
      if (streams.get(key) === stream) streams.delete(key)
      return
    }
    const ids = [...new Set(stream.mailboxes.values())].slice(0, 20)
    const source = new EventSource(`${EMAIL_GATEWAY_URL}/v1/events/stream?mailboxIds=${ids.join(',')}&after=${stream.cursor}`, {
      fetch: async (input, init) => fetch(input, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await emailBearer(ownerUserId)}` }, redirect: 'error' }),
    })
    stream.source = source
    for (const kind of EMAIL_WAKE_KINDS) {
      source.addEventListener(kind, (event: MessageEvent) => {
        if (kind === 'ready') return wake(ids, { kind })
        const cursor = Number(event.lastEventId)
        if (!Number.isSafeInteger(cursor) || cursor <= 0) return wake(mailboxesOf(event, ids), { kind })
        stream.cursor = Math.max(stream.cursor, cursor)
        wake(mailboxesOf(event, ids), { kind, cursor })
      })
    }
  }
  stream.mailboxes.set(integrationId, mailboxId)
  reconnect()
  return () => { stream.mailboxes.delete(integrationId); reconnect() }
}

/** The stream's mailbox an event names, or all of them when it names none of them. */
function mailboxesOf(event: MessageEvent, ids: readonly string[]): readonly string[] {
  let data: unknown
  try { data = JSON.parse(String(event.data)) } catch { return ids }
  const named = streamEventSchema.safeParse(data)
  return named.success && ids.includes(named.data.mailboxId) ? [named.data.mailboxId] : ids
}

/**
 * Sends each mailbox a wake. `ready` (each connect of the stream) carries no
 * cursor, so it always polls. Sending acknowledges nothing: only the poll
 * moves a mailbox's cursor.
 */
function wake(mailboxIds: readonly string[], hint: Omit<EmailMailboxWake, 'mailboxId'>): void {
  for (const mailboxId of mailboxIds) {
    background(async () => { await appState().publish(emailMailboxWake.channel(mailboxId), { mailboxId, ...hint }) }, { name: 'email-live.wake' })
  }
}
