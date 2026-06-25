// src/shared/lib/chat-integrations/chat-integration-marker-advance.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@shared/lib/db'
import { chatIntegrations, chatIntegrationSessions } from '@shared/lib/db/schema'
import { createChatIntegrationSession, getLastSeenTs } from '@shared/lib/services/chat-integration-session-service'
import { advanceConversationMarker } from './chat-integration-manager'

const INT = 'int-advance-test'
beforeEach(() => {
  db.delete(chatIntegrationSessions).run()
  db.delete(chatIntegrations).run()
  db.insert(chatIntegrations).values({
    id: INT, agentSlug: 'a', provider: 'slack', name: 'n', config: '{}',
    showToolCalls: false, status: 'active', requireApproval: true,
    createdAt: new Date(), updatedAt: new Date(),
  } as any).run()
})

describe('advanceConversationMarker', () => {
  it('records externalMessageId as the marker for the row', () => {
    const id = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    advanceConversationMarker(id, '123.45')
    expect(getLastSeenTs(INT, 'C1')).toBe('123.45')
  })

  it('only advances forward (ignores an older externalMessageId)', () => {
    const id = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    advanceConversationMarker(id, '200.0')
    advanceConversationMarker(id, '100.0') // out-of-order/duplicate delivery
    expect(getLastSeenTs(INT, 'C1')).toBe('200.0')
  })

  it('is a no-op for an empty external id', () => {
    const id = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    advanceConversationMarker(id, '')
    expect(getLastSeenTs(INT, 'C1')).toBeNull()
  })
})
