import { describe, it, expect, vi } from 'vitest'
import type { WebhookRelaySnapshot } from '@shared/lib/webhook-relay'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn<() => WebhookRelaySnapshot>() }))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))
vi.mock('@shared/lib/webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/webhook-relay')>()),
  getWebhookRelay: () => ({ snapshot: mocks.snapshot }),
}))

import webhookRelay from './webhook-relay'

describe('GET /api/webhook-relay', () => {
  it('returns the relay status without the last error', async () => {
    mocks.snapshot.mockReturnValue({
      available: true,
      unavailableReason: null,
      transport: 'unreachable',
      lastClaimAt: '2026-09-23T00:00:00.000Z',
      lastError: 'Webhook relay /v1/webhook-events/poll failed with 403: member sub_x left the org',
    })

    const res = await webhookRelay.request('http://localhost/')

    expect(await res.json()).toEqual({
      available: true,
      unavailableReason: null,
      transport: 'unreachable',
      lastClaimAt: '2026-09-23T00:00:00.000Z',
    })
  })
})
