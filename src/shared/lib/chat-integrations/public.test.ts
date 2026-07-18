import { describe, expect, it } from 'vitest'
import type { ChatIntegration } from '@shared/lib/db/schema'
import { toPublicChatIntegration } from './public'

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
    effort: null,
    speed: null,
    status: 'active',
    errorMessage: null,
    createdByUserId: 'owner-1',
    createdAt: new Date('2026-07-17T00:00:00Z'),
    updatedAt: new Date('2026-07-17T00:00:00Z'),
  }
}

describe('toPublicChatIntegration', () => {
  it.each([
    ['telegram', { botToken: 'tg-secret', chatId: 'chat-secret', draftStreaming: true }, { draftStreaming: true }],
    ['slack', { botToken: 'xoxb-secret', appToken: 'xapp-secret', channelId: 'channel-secret', onlyMentioned: true }, { onlyMentioned: true }],
    ['imessage', { gatewayUrl: 'https://private.gateway.example', phoneNumber: '+15551234567', token: 'imessage-secret' }, {}],
  ] as const)('redacts all %s config while retaining safe settings', (provider, config, settings) => {
    const result = toPublicChatIntegration(integration(provider, config))
    const serialized = JSON.stringify(result)

    expect(result).not.toHaveProperty('config')
    expect(result.hasCredentials).toBe(true)
    expect(result.settings).toEqual(settings)
    for (const value of Object.values(config)) {
      if (typeof value === 'string') expect(serialized).not.toContain(value)
    }
  })

  it('reports an invalid stored credential config without exposing it', () => {
    const result = toPublicChatIntegration(integration('slack', { onlyMentioned: true }))

    expect(result).not.toHaveProperty('config')
    expect(result.hasCredentials).toBe(false)
    expect(result.settings).toEqual({})
  })
})
