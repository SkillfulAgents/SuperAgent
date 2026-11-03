import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../platform-attribution', () => ({
  attribution: { fromUserId: async () => ({ bearerToken: () => 'test-member-bearer' }) },
}))
vi.mock('../services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'test-platform-token' }))

import { EmailGatewayClient, emailEventsSchema } from './gateway-client'

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
