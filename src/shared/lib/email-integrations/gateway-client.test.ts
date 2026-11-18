import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/** Settings reads, counted; the platform token each read finds. */
const state = vi.hoisted(() => ({ reads: 0, token: 'test-platform-token' as string | null }))
vi.mock('../config/settings', () => ({
  getSettings: async () => {
    state.reads++
    return {}
  },
}))
vi.mock('../platform-attribution', () => ({
  attribution: {
    fromUserId: async () => ({ bearerToken: () => 'test-member-bearer' }),
    current: async () => null,
    requiresActingMember: async () => true,
  },
}))
vi.mock('../services/platform-auth-service', () => ({ platformAccessTokenFrom: () => state.token }))

import { EmailGatewayClient, emailEventsSchema, EmailGatewayError } from './gateway-client'

beforeEach(() => {
  state.reads = 0
  state.token = 'test-platform-token'
})
afterEach(() => vi.unstubAllGlobals())

it('reads an event batch without optional data and preserves the message IDs and cursor used by polling', async () => {
  const events = [
    { cursor: 11, mailboxId: 'mailbox', type: 'message.received', messageId: 'message-1', createdAt: 100 },
    { cursor: 12, mailboxId: 'mailbox', type: 'mailbox.updated', messageId: null, createdAt: 101 },
  ]
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: events, cursor: 12, hasMore: false }))
  vi.stubGlobal('fetch', fetcher)

  const batch = await new EmailGatewayClient('owner').json('/events?after=10', emailEventsSchema)
  expect(batch).toEqual({ data: events, cursor: 12, hasMore: false })
  expect(batch.data[0].messageId).toBe('message-1')
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-member-bearer')
})

it.each(['cursor', 'messageId'] as const)('still rejects an event missing its required %s', async (field) => {
  const event: Record<string, unknown> = { cursor: 11, mailboxId: 'mailbox', type: 'message.received', messageId: 'message-1', createdAt: 100 }
  delete event[field]
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [event], cursor: 11, hasMore: false })))
  await expect(new EmailGatewayClient('owner').json('/events', emailEventsSchema)).rejects.toThrow()
})

const emptyBatch = () => Response.json({ data: [], cursor: 0, hasMore: false })

it('resolves the bearer from one settings read per request when no operation is open', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => emptyBatch()))
  const client = new EmailGatewayClient('owner')
  await client.json('/events', emailEventsSchema)
  await client.json('/events', emailEventsSchema)
  expect(state.reads).toBe(2)
})

it('shares one bearer across an operation, however many requests it makes, and resolves again for the next', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => emptyBatch()))
  const client = new EmailGatewayClient('owner')

  const readsFor = async (requests: number) => {
    const before = state.reads
    const operation = client.forOperation()
    await Promise.all(Array.from({ length: requests }, () => operation.json('/events', emailEventsSchema)))
    return state.reads - before
  }

  expect(await readsFor(1)).toBe(1)
  expect(await readsFor(6)).toBe(1)
})

it('reads one bearer for every page of a thread', async () => {
  const page = (n: number, hasMore: boolean) => Response.json({ messages: [], cursor: n, hasMore })
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(page(1, true))
    .mockResolvedValueOnce(page(2, true))
    .mockResolvedValueOnce(page(3, false))
  vi.stubGlobal('fetch', fetcher)

  await new EmailGatewayClient('owner').thread('mailbox', 'thread')
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(state.reads).toBe(1)
})

it('does not keep a failed resolution: the next request in the operation tries again', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => emptyBatch()))
  const operation = new EmailGatewayClient('owner').forOperation()

  state.token = null
  await expect(operation.json('/events', emailEventsSchema)).rejects.toBeInstanceOf(EmailGatewayError)
  state.token = 'test-platform-token'
  await expect(operation.json('/events', emailEventsSchema)).resolves.toEqual({ data: [], cursor: 0, hasMore: false })
  expect(state.reads).toBe(2)
})
