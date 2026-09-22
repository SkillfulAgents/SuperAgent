import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
let handle: TestDatabase
let database: AppDatabase
vi.mock('../db', () => ({ get db() { return database } }))
import { createAgentIntegration, getAgentIntegration, updateAgentIntegrationStatus } from '../services/agent-integration-service'
import { onIntegrationAuthorizationLost, requireIntegrationReconnect } from './lifecycle'

beforeEach(async () => { handle = await createTestDatabase(); database = handle.db })
afterEach(async () => { await handle.close() })

describe('terminal integration authorization loss', () => {
  it.each(['active', 'paused'] as const)('clears credentials atomically while preserving %s intent', async status => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'old' }, status })
    const before = (await getAgentIntegration(id))!
    const observed = vi.fn()
    const unsubscribe = onIntegrationAuthorizationLost(observed)
    try {
      expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: before.config, config: {}, message: 'Reconnect this account' })).toBe(true)
      const after = (await getAgentIntegration(id))!
      expect(after).toMatchObject({ config: '{}', status: status === 'paused' ? 'paused' : 'disconnected', errorMessage: 'Reconnect this account' })
      expect(observed).toHaveBeenCalledExactlyOnceWith({ integrationId: id, config: '{}' })
      if (status === 'active') {
        expect(await updateAgentIntegrationStatus(id, 'error', 'Late transport failure')).toBe(false)
        expect(await updateAgentIntegrationStatus(id, 'active')).toBe(false)
        expect((await getAgentIntegration(id))?.status).toBe('disconnected')
        expect(await updateAgentIntegrationStatus(id, 'active', null, true)).toBe(true)
      }
    } finally { unsubscribe() }
  })
  it('ignores a rejection of superseded credentials without changing lifecycle or notifying', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'replacement' } })
    const observed = vi.fn(); const unsubscribe = onIntegrationAuthorizationLost(observed)
    try {
      expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: '{"botToken":"old"}', config: {}, message: 'Revoked' })).toBe(false)
      expect((await getAgentIntegration(id))?.status).toBe('active')
      expect((await getAgentIntegration(id))?.config).toContain('replacement')
      expect(observed).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })
})
