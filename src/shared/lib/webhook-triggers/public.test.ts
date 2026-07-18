import { describe, expect, it } from 'vitest'
import type { WebhookTrigger } from '@shared/lib/db/schema'
import { toPublicWebhookTrigger } from './public'

const trigger: WebhookTrigger = {
  id: 'trigger-1',
  agentSlug: 'agent-1',
  kind: 'custom',
  composioTriggerId: 'whep_private-id',
  connectedAccountId: 'account-private-id',
  triggerType: 'CUSTOM_WEBHOOK',
  triggerConfig: JSON.stringify({
    url: 'https://hooks.example.test/private-capability',
    endpointId: 'whep_private-id',
  }),
  prompt: 'Handle the event',
  name: 'Inbound events',
  status: 'active',
  lastFiredAt: null,
  fireCount: 0,
  lastSessionId: null,
  createdBySessionId: null,
  createdByUserId: 'owner-private-id',
  model: null,
  effort: null,
  speed: null,
  createdAt: new Date('2026-07-17T00:00:00Z'),
  cancelledAt: null,
  pausedAt: null,
}

describe('toPublicWebhookTrigger', () => {
  it.each(['viewer', 'user', null] as const)(
    'redacts capability and owner fields for %s access',
    (role) => {
      const result = toPublicWebhookTrigger(trigger, role)
      const serialized = JSON.stringify(result)

      expect(result).not.toHaveProperty('triggerConfig')
      expect(result).not.toHaveProperty('composioTriggerId')
      expect(result).not.toHaveProperty('connectedAccountId')
      expect(result).not.toHaveProperty('createdByUserId')
      expect(result).toMatchObject({ id: 'trigger-1', name: 'Inbound events' })
      expect(serialized).not.toContain('private-capability')
      expect(serialized).not.toContain('private-id')
    },
  )

  it('retains capability and owner fields for owners', () => {
    expect(toPublicWebhookTrigger(trigger, 'owner')).toEqual(trigger)
  })
})
