import { describe, expect, it, vi } from 'vitest'
import { createFakeWebhookRelay } from './testing/fake-webhook-relay'
import { watchWebhookRelay } from './status'
import type { WebhookRelaySnapshot } from './types'

const available: WebhookRelaySnapshot = {
  available: true,
  unavailableReason: null,
  transport: 'realtime',
  lastClaimAt: null,
  lastError: 'claim failed with 403: member sub_x left',
}

describe('watchWebhookRelay', () => {
  it('reconciles agents with the current availability, then on every change', () => {
    const relay = createFakeWebhookRelay()
    relay.setSnapshot({ ...available, available: false, unavailableReason: 'stopped', transport: 'idle' })
    const broadcast = vi.fn()
    const reconcileAgents = vi.fn()

    watchWebhookRelay(relay, { broadcast, reconcileAgents })
    expect(reconcileAgents).toHaveBeenLastCalledWith(false)

    relay.setSnapshot(available)
    expect(reconcileAgents).toHaveBeenLastCalledWith(true)
    expect(broadcast).toHaveBeenLastCalledWith({
      available: true,
      unavailableReason: null,
      transport: 'realtime',
      lastClaimAt: null,
    })
  })

  it('stops publishing once unsubscribed', () => {
    const relay = createFakeWebhookRelay()
    const broadcast = vi.fn()

    const stop = watchWebhookRelay(relay, { broadcast, reconcileAgents: vi.fn() })
    stop()
    relay.setSnapshot({ ...available, transport: 'polling' })

    expect(broadcast).not.toHaveBeenCalled()
  })
})
