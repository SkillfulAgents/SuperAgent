import { describe, expect, it } from 'vitest'
import type { ChatIntegration } from '@shared/lib/db/schema'
import { toPublicChatIntegration } from './public'
import { toPublicAgentIntegration } from '../agent-integrations/serialization'

function integration(provider: ChatIntegration['provider'], config: Record<string, unknown>): ChatIntegration {
  return {
    id: `${provider}-1`,
    agentSlug: 'agent-1',
    provider,
    name: 'Bot',
    config: JSON.stringify(config),
    showToolCalls: false,
    requireApproval: true,
    sessionTimeout: null,
    model: null,
  llmProviderId: null,
    effort: null,
    speed: null,
    status: 'active',
    errorMessage: null,
    createdByUserId: 'owner-1',
    createdAt: new Date('2026-07-17T00:00:00Z'),
    updatedAt: new Date('2026-07-17T00:00:00Z'),
  }
}

describe.each([toPublicChatIntegration, toPublicAgentIntegration])('%s', (serialize) => {
  it.each([
    ['telegram', { botToken: 'tg-secret', chatId: 'chat-secret', draftStreaming: true }, { draftStreaming: true }],
    ['slack', { botToken: 'xoxb-secret', appToken: 'xapp-secret', channelId: 'channel-secret', onlyMentioned: true }, { onlyMentioned: true }],
    ['imessage', { gatewayUrl: 'https://private.gateway.example', phoneNumber: '+15551234567', token: 'imessage-secret' }, {}],
  ] as const)('redacts all %s config while retaining safe settings', (provider, config, settings) => {
    const result = serialize(integration(provider, config))
    const serialized = JSON.stringify(result)

    expect(result).not.toHaveProperty('config')
    expect(result.hasCredentials).toBe(true)
    expect(result.settings).toEqual(settings)
    for (const value of Object.values(config)) {
      if (typeof value === 'string') expect(serialized).not.toContain(value)
    }
  })

  it('shows how a Slack app reaches the installation, without its secrets', () => {
    const relay = { endpointId: 'whep_1', url: 'https://relay.test/v1/hooks/whep_1', scope: 'sub_1' }
    const socket = serialize(integration('slack', { botToken: 'xoxb-secret', appToken: 'xapp-secret' }))
    expect(socket).toMatchObject({ slack: { botTokenSaved: true, appTokenSaved: true, signingSecretSaved: false, webhook: null } })
    expect(socket).not.toHaveProperty('refreshIntervalMs')

    // Set up with webhooks, the Slack app not created yet.
    const waiting = serialize(integration('slack', { onlyMentioned: true, relay }))
    expect(waiting).toMatchObject({ hasCredentials: false, refreshIntervalMs: 5000, slack: { botTokenSaved: false, webhook: { url: relay.url, status: 'pending' } } })

    const verified = serialize(integration('slack', { botToken: 'xoxb-secret', signingSecret: 'signing-secret', relay, webhookStatus: 'verified' }))
    expect(verified).toMatchObject({ hasCredentials: true, slack: { signingSecretSaved: true, webhook: { status: 'verified' } } })
    expect(verified).not.toHaveProperty('refreshIntervalMs')
    expect(JSON.stringify(verified)).not.toContain('signing-secret')
    expect(JSON.stringify(verified)).not.toContain('sub_1')
  })

  it('reports an invalid stored credential config without exposing it', () => {
    const result = serialize(integration('slack', { onlyMentioned: true }))

    expect(result).not.toHaveProperty('config')
    expect(result.hasCredentials).toBe(false)
    expect(result.settings).toEqual({})
  })
})
