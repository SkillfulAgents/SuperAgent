// src/shared/lib/services/chat-integration-session-service.marker.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@shared/lib/db'
import { chatIntegrations, chatIntegrationSessions } from '@shared/lib/db/schema'
import {
  createChatIntegrationSession,
  archiveChatIntegrationSession,
  getLastSeenTs,
  setLastSeenTs,
} from './chat-integration-session-service'

const INT = 'int-marker-test'

beforeEach(() => {
  db.delete(chatIntegrationSessions).run()
  db.delete(chatIntegrations).run()
  db.insert(chatIntegrations).values({
    id: INT, agentSlug: 'a', provider: 'slack', name: 'n', config: '{}',
    showToolCalls: false, status: 'active', requireApproval: true,
    createdAt: new Date(), updatedAt: new Date(),
  } as any).run()
})

describe('getLastSeenTs / setLastSeenTs', () => {
  it('returns null when no session exists', () => {
    expect(getLastSeenTs(INT, 'C1')).toBeNull()
  })

  it('returns null when sessions exist but no marker is set', () => {
    createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    expect(getLastSeenTs(INT, 'C1')).toBeNull()
  })

  it('sets and reads the marker for the active row', () => {
    const id = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    setLastSeenTs(id, '100.5')
    expect(getLastSeenTs(INT, 'C1')).toBe('100.5')
  })

  it('compares numerically, not lexically', () => {
    const id = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    // lexically "9.0" > "10.0"; numerically 9 < 10. Max must be "10.0".
    setLastSeenTs(id, '9.0')
    const id2 = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's2' })
    setLastSeenTs(id2, '10.0')
    expect(getLastSeenTs(INT, 'C1')).toBe('10.0')
  })

  it('carries forward across rotation: reads the max even from an archived row', () => {
    const oldId = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's-old' })
    setLastSeenTs(oldId, '500.0')
    archiveChatIntegrationSession(oldId)
    // New (active) row has no marker yet.
    createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's-new' })
    expect(getLastSeenTs(INT, 'C1')).toBe('500.0')
  })

  it('scopes by conversation (integrationId + externalChatId)', () => {
    const a = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C1', sessionId: 's1' })
    setLastSeenTs(a, '100.0')
    const b = createChatIntegrationSession({ integrationId: INT, externalChatId: 'C2', sessionId: 's2' })
    setLastSeenTs(b, '200.0')
    expect(getLastSeenTs(INT, 'C1')).toBe('100.0')
    expect(getLastSeenTs(INT, 'C2')).toBe('200.0')
  })
})
