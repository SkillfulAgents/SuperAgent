import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentIntegrationRecord } from './types'
import type { FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'

const { listStartupIntegrations } = vi.hoisted(() => ({ listStartupIntegrations: vi.fn() }))
vi.mock('./store', () => ({ listStartupIntegrations }))
vi.mock('../webhook-relay', async () => {
  const { createFakeWebhookRelay } = await import('../webhook-relay/testing/fake-webhook-relay')
  const relay = createFakeWebhookRelay()
  return { getWebhookRelay: () => relay }
})

const { syncIntegrationForwarding } = await import('./relay-forwarding')
const relay = (await import('../webhook-relay')).getWebhookRelay() as FakeWebhookRelay

function integration(id: string, agentSlug: string, config: object): AgentIntegrationRecord {
  return { id, agentSlug, provider: 'slack', config: JSON.stringify(config), status: 'active' } as AgentIntegrationRecord
}
const slackRelay = { relay: { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_owner' } }
const event = { id: 'whe_1', endpointId: 'whep_1', type: 'CUSTOM_WEBHOOK', payload: { text: 'Can you send the Q3 numbers?' }, createdAt: '2026-11-02T12:00:00.000Z' }
const accepted = vi.fn(async (_agentSlug: string, _integrationId: string, events: readonly { id: string }[]) => new Map(events.map((e) => [e.id, 'accepted' as const])))

afterEach(async () => {
  listStartupIntegrations.mockResolvedValue([])
  await syncIntegrationForwarding(accepted)
  relay.reset()
  vi.clearAllMocks()
})

describe('syncIntegrationForwarding', () => {
  it('claims for each active integration with webhooks and hands its events to its agent', async () => {
    listStartupIntegrations.mockResolvedValue([integration('slack-1', 'sales-agent', slackRelay), integration('telegram-1', 'support-agent', {})])

    await syncIntegrationForwarding(accepted)

    expect([...relay.consumers.values()].map(({ id, scope, endpointIds }) => [id, scope, endpointIds])).toEqual([['forward:integration:slack-1', 'sub_owner', ['whep_1']]])
    expect(await relay.deliver('forward:integration:slack-1', [event])).toEqual(new Map([['whe_1', 'accepted']]))
    expect(accepted).toHaveBeenCalledWith('sales-agent', 'slack-1', [event])
  })

  it('keeps one registration across syncs and stops claiming once the integration is paused or removed', async () => {
    listStartupIntegrations.mockResolvedValue([integration('slack-1', 'sales-agent', slackRelay)])
    await syncIntegrationForwarding(accepted)
    await syncIntegrationForwarding(accepted)
    listStartupIntegrations.mockResolvedValue([])
    await syncIntegrationForwarding(accepted)

    expect(relay.consumers.size).toBe(0)
    expect(relay.log.map(({ op }) => op)).toEqual(['register', 'update', 'dispose'])
  })

  it('hands events to the function the latest sync was given', async () => {
    listStartupIntegrations.mockResolvedValue([integration('slack-1', 'sales-agent', slackRelay)])
    const forwardFor = () => vi.fn(async (_agentSlug: string, _integrationId: string, events: readonly { id: string }[]) =>
      new Map(events.map((e) => [e.id, 'accepted' as const])))
    const firstPass = forwardFor()
    const secondPass = forwardFor()
    await syncIntegrationForwarding(firstPass)
    await syncIntegrationForwarding(secondPass)

    await relay.deliver('forward:integration:slack-1', [event])

    expect(firstPass).not.toHaveBeenCalled()
    expect(secondPass).toHaveBeenCalledWith('sales-agent', 'slack-1', [event])
  })
})
