import { afterEach, expect, it, vi } from 'vitest'
type StreamEvent = { lastEventId: string; data?: string }
const state = vi.hoisted(() => ({ sources: [] as Array<{ url: string; options: { fetch: typeof fetch }; close: ReturnType<typeof vi.fn>; handlers: Map<string, (event: StreamEvent) => void> }>, token: 'first' }))
vi.mock('eventsource', () => ({ EventSource: class {
  close = vi.fn()
  handlers = new Map()
  constructor(readonly url: string, readonly options: { fetch: typeof fetch }) { state.sources.push(this) }
  addEventListener(type: string, callback: unknown) { this.handlers.set(type, callback) }
} }))
vi.mock('./gateway-client', () => ({ emailBearer: async () => state.token }))
import { appState } from '../app-state'
import { backgroundSettled } from '../background'
import { watchEmail } from './live'
import { emailMailboxWake, type EmailMailboxWake } from './wake'
afterEach(() => { state.sources.length = 0; vi.unstubAllGlobals() })

/** Every wake sent to these mailboxes, in order. */
async function wakes(...mailboxIds: string[]): Promise<EmailMailboxWake[]> {
  const heard: EmailMailboxWake[] = []
  await appState().subscribe(mailboxIds.map(id => emailMailboxWake.channel(id)), wake => { heard.push(wake) })
  return heard
}
const received = (mailboxId: string, cursor: number): StreamEvent => ({ lastEventId: String(cursor), data: JSON.stringify({ cursor, mailboxId, type: 'message.received', messageId: 'message', createdAt: 1 }) })

it('shares one SSE stream per member, preserves its cursor, and closes after the last subscriber', async () => {
  const heard = await wakes('mailbox-a', 'mailbox-b')
  const stopA = watchEmail(null, 'member', 'integration-a', 'mailbox-a')
  const stopB = watchEmail(null, 'member', 'integration-b', 'mailbox-b')
  expect(state.sources[0].close).toHaveBeenCalledOnce()
  expect(state.sources[1].url).toContain('mailbox-a,mailbox-b')
  state.sources[1].handlers.get('message.received')!(received('mailbox-b', 42))
  await backgroundSettled()
  // Only the mailbox the event is about, with the event's cursor.
  expect(heard).toEqual([{ mailboxId: 'mailbox-b', kind: 'message.received', cursor: 42 }])
  stopA()
  expect(state.sources[2].url).toContain('after=42')
  expect(state.sources[2].url).not.toContain('mailbox-a')
  stopB()
  expect(state.sources[2].close).toHaveBeenCalledOnce()
})
it('wakes every mailbox of the stream on each connect, without a cursor that could skip the poll', async () => {
  const heard = await wakes('mailbox-a', 'mailbox-b')
  const stopA = watchEmail(null, 'member-3', 'integration-a', 'mailbox-a')
  const stopB = watchEmail(null, 'member-3', 'integration-b', 'mailbox-b')
  try {
    // The client repeats the last event id on the events after a reconnect, `ready` included.
    state.sources[1].handlers.get('ready')!({ lastEventId: '42', data: '{"cursor":42}' })
    await backgroundSettled()
    expect(heard).toEqual([{ mailboxId: 'mailbox-a', kind: 'ready' }, { mailboxId: 'mailbox-b', kind: 'ready' }])
  } finally { stopA(); stopB() }
})
it('wakes every mailbox of the stream for an event that names none of them', async () => {
  const heard = await wakes('mailbox-a', 'mailbox-b')
  const stopA = watchEmail(null, 'member-4', 'integration-a', 'mailbox-a')
  const stopB = watchEmail(null, 'member-4', 'integration-b', 'mailbox-b')
  try {
    state.sources[1].handlers.get('thread.reconciled')!({ lastEventId: '7', data: 'not json' })
    state.sources[1].handlers.get('message.received')!(received('mailbox-elsewhere', 8))
    await backgroundSettled()
    expect(heard).toEqual([
      { mailboxId: 'mailbox-a', kind: 'thread.reconciled', cursor: 7 }, { mailboxId: 'mailbox-b', kind: 'thread.reconciled', cursor: 7 },
      { mailboxId: 'mailbox-a', kind: 'message.received', cursor: 8 }, { mailboxId: 'mailbox-b', kind: 'message.received', cursor: 8 },
    ])
  } finally { stopA(); stopB() }
})
it('refreshes bearer auth for every SSE reconnect, rejects redirects, and never puts it in a wake', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(''))
  vi.stubGlobal('fetch', fetcher)
  const sent = vi.spyOn(appState(), 'publish')
  const stop = watchEmail(null, 'member-2', 'integration', 'mailbox')
  try {
    for (const token of ['first', 'rotated']) {
      state.token = token
      await state.sources[0].options.fetch('https://email-gateway.datawizz.workers.dev/v1/events/stream', {})
      expect(fetcher).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ headers: { Authorization: `Bearer ${token}` }, redirect: 'error' }))
    }
    state.sources[0].handlers.get('message.received')!(received('mailbox', 3))
    await backgroundSettled()
    expect(sent).toHaveBeenCalledOnce()
    expect(JSON.stringify(sent.mock.calls)).not.toMatch(/first|rotated/)
  } finally { stop(); vi.restoreAllMocks() }
})
