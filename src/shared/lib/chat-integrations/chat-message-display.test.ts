import { describe, expect, it } from 'vitest'
import type { AgentIntegrationRecord, IntegrationInputContext } from '../agent-integrations/types'
import type { ChatConversationType, IncomingMessage } from './chat-agent-integration'
import { MockChatAgentIntegration } from './mock-connector'
import { slackLinks } from './slack-connector'
import { inputEvent } from './test-helpers'

class ChannelChat extends MockChatAgentIntegration {
  static classifyChatId = (): ChatConversationType => 'channel'
}
class DirectChat extends MockChatAgentIntegration {
  static classifyChatId = (): ChatConversationType => 'dm'
}

const record: AgentIntegrationRecord = { id: 'integration', agentSlug: 'agent', provider: 'slack', config: '{}', name: null, status: 'active',
  errorMessage: null, model: null, llmProviderId: null, effort: null, speed: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }
const context = { integration: record, externalId: 'C1' } as IntegrationInputContext
const sentAt = new Date('2026-09-22T10:00:00.000Z')

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return { externalMessageId: '1', chatId: 'C1', text: 'hello team', userId: 'U1', userName: 'Ada Lovelace', chatName: '#general', timestamp: sentAt, ...overrides }
}

describe('chat message display', () => {
  it('keeps the attribution prefix for the agent and lifts the sender into the card', async () => {
    const prepared = await new ChannelChat().prepareInput(inputEvent(message({
      display: { avatarUrl: 'https://avatars.slack-edge.com/ada.png', workspace: 'Acme', messageUrl: 'https://acme.slack.com/archives/C1/p1', conversationUrl: 'https://acme.slack.com/archives/C1' },
    })), context)

    expect(prepared.text).toBe('\\[Ada Lovelace]: hello team')
    expect(prepared.display).toEqual({
      event: { type: 'message', label: 'Channel message' },
      request: {
        text: 'hello team', sentAt: sentAt.toISOString(), url: 'https://acme.slack.com/archives/C1/p1',
        author: { name: 'Ada Lovelace', avatarUrl: 'https://avatars.slack-edge.com/ada.png' },
      },
      source: { kind: 'channel', title: '#general', url: 'https://acme.slack.com/archives/C1', workspace: 'Acme' },
    })
  })

  it('labels a direct message and shows only what the person wrote, not injected thread history', async () => {
    const prepared = await new DirectChat().prepareInput(inputEvent(message({
      text: 'Earlier in thread:\n- Bob: context\n\nwhat about now?',
      display: { requestText: 'what about now?' },
    })), context)

    expect(prepared.text).toBe('Earlier in thread:\n- Bob: context\n\nwhat about now?')
    expect(prepared.display).toMatchObject({ event: { label: 'Direct message' }, request: { text: 'what about now?' }, source: { kind: 'direct' } })
  })

  it('drops links that are not public https and never carries file URLs', async () => {
    const prepared = await new DirectChat().prepareInput(inputEvent(message({
      display: { avatarUrl: 'http://tracker.example/pixel.png', messageUrl: 'javascript:alert(1)', conversationUrl: 'https://user:pass@example.com/' },
    })), context)

    expect(prepared.display?.request?.author).toEqual({ name: 'Ada Lovelace', avatarUrl: undefined })
    expect(prepared.display?.request?.url).toBeUndefined()
    expect(prepared.display?.source.url).toBeUndefined()
  })
})

describe('slackLinks', () => {
  it('links a channel message and its channel', () => {
    expect(slackLinks('https://acme.slack.com/', 'C123', '1726999999.000100')).toEqual({
      messageUrl: 'https://acme.slack.com/archives/C123/p1726999999000100',
      conversationUrl: 'https://acme.slack.com/archives/C123',
    })
  })

  it('links a thread reply in its thread, and the conversation to the thread root', () => {
    expect(slackLinks('https://acme.slack.com/', 'C123', '1726999999.000200', '1726999999.000100')).toEqual({
      messageUrl: 'https://acme.slack.com/archives/C123/p1726999999000200?thread_ts=1726999999.000100&cid=C123',
      conversationUrl: 'https://acme.slack.com/archives/C123/p1726999999000100',
    })
  })

  it('has no links without the workspace URL', () => {
    expect(slackLinks(undefined, 'C123', '1.2')).toEqual({})
  })
})
