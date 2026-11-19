import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
let handle: TestDatabase
let database: AppDatabase
vi.mock('../db', () => ({ get db() { return database } }))
import { eq } from 'drizzle-orm'
import { appState } from '../app-state'
import { backgroundSettled } from '../background'
import { chatIntegrations, integrationDeliveries } from '../db/schema'
import { createAgentIntegration, getAgentIntegration, updateAgentIntegrationStatus } from '../services/agent-integration-service'
import { revokeLinearAuthorization, updateLinearConfig } from '../task-manager-integrations/linear/store'
import { integrationAuthorization, type IntegrationAuthorizationEvent } from './authorization-events'
import { deliveryStore } from './delivery-store'
import { requireIntegrationReconnect } from './lifecycle'

beforeEach(async () => { handle = await createTestDatabase(); database = handle.db })
afterEach(async () => { vi.restoreAllMocks(); await handle.close() })

/** Every authorization event sent for the integration while the test runs. */
async function observe(integrationId: string): Promise<IntegrationAuthorizationEvent[]> {
  const events: IntegrationAuthorizationEvent[] = []
  await appState().subscribe([integrationAuthorization.channel(integrationId)], event => { events.push(event) })
  return events
}
const input = (id: string) => ({ type: 'input' as const, id, externalId: 'chat', timestamp: new Date(), payload: {} })
const route = { externalId: 'chat', interactionId: 'chat', replyTarget: {}, action: 'run' as const }
/** A re-authorization: new credentials, active again. */
const reauthorize = (id: string) => database.update(chatIntegrations).set({ config: '{"botToken":"new"}', status: 'active', errorMessage: null }).where(eq(chatIntegrations.id, id)).run()
const stateOf = async (eventId: string) => (await database.select().from(integrationDeliveries).where(eq(integrationDeliveries.eventId, eventId)).get())?.state

describe('terminal integration authorization loss', () => {
  it.each(['active', 'paused'] as const)('clears credentials atomically while preserving %s intent', async status => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'old' }, status })
    const before = (await getAgentIntegration(id))!
    const observed = await observe(id)
    expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: before.config, config: {}, message: 'Reconnect this account' })).toBe(true)
    const after = (await getAgentIntegration(id))!
    expect(after).toMatchObject({ config: '{}', status: status === 'paused' ? 'paused' : 'disconnected', errorMessage: 'Reconnect this account' })
    await backgroundSettled()
    expect(observed).toEqual([{ type: 'authorization_lost', integrationId: id, version: after.version }])
    if (status === 'active') {
      expect(await updateAgentIntegrationStatus(id, 'error', 'Late transport failure')).toBe(false)
      expect(await updateAgentIntegrationStatus(id, 'active', null, { unlessDisconnected: true })).toBe(false)
      expect((await getAgentIntegration(id))?.status).toBe('disconnected')
      expect(await updateAgentIntegrationStatus(id, 'active', null, { config: before.config })).toBe(false)
      expect((await getAgentIntegration(id))?.status).toBe('disconnected')
      expect(await updateAgentIntegrationStatus(id, 'active', null, { config: after.config })).toBe(true)
    }
  })
  it('ignores a rejection of superseded credentials without changing lifecycle or notifying', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'replacement' } })
    const observed = await observe(id)
    expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: '{"botToken":"old"}', config: {}, message: 'Revoked' })).toBe(false)
    expect((await getAgentIntegration(id))?.status).toBe('active')
    expect((await getAgentIntegration(id))?.config).toContain('replacement')
    await backgroundSettled()
    expect(observed).toEqual([])
  })
  it('names the integration only, never a credential', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'bot-secret-1234' } })
    const sent = vi.spyOn(appState(), 'publish')
    const before = (await getAgentIntegration(id))!
    await requireIntegrationReconnect({ integrationId: id, expectedConfig: before.config, config: { botToken: 'next-secret-5678' }, message: 'Reconnect' })
    expect(sent).toHaveBeenCalledOnce()
    expect(sent.mock.calls[0][1]).toEqual({ type: 'authorization_lost', integrationId: id, version: (await getAgentIntegration(id))!.version })
    expect(JSON.stringify(sent.mock.calls[0])).not.toMatch(/secret/)
  })

  it('cancels the input it accepted without the hint, so authorizing again does not run it', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'old' } })
    expect(await deliveryStore.accept(id, input('before'), route)).toBe('accepted')
    // The hint is lost: nobody hears of the loss.
    vi.spyOn(appState(), 'publish').mockResolvedValue(undefined)
    const before = (await getAgentIntegration(id))!
    expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: before.config, config: {}, message: 'Reconnect' })).toBe(true)
    expect(await stateOf('before')).toBe('cancelled')
    expect(await deliveryStore.accept(id, input('while-revoked'), route)).toBe('rejected')

    // Authorized again: the old input stays cancelled, new input runs.
    await reauthorize(id)
    expect((await deliveryStore.due([id])).map(row => row.eventId)).toEqual([])
    expect(await deliveryStore.accept(id, input('after'), route)).toBe('accepted')
    expect((await deliveryStore.due([id])).map(row => row.eventId)).toEqual(['after'])
  })
  it('keeps input accepted under an authorization that replaced the revoked one before its cancel ran', async () => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'old' } })
    const cancelStopped = deliveryStore.cancelStopped.bind(deliveryStore)
    // A re-authorization and its first input land between the revocation and the cancel.
    vi.spyOn(deliveryStore, 'cancelStopped').mockImplementation(async integrationId => {
      await reauthorize(id)
      expect(await deliveryStore.accept(id, input('fresh'), route)).toBe('accepted')
      await cancelStopped(integrationId)
    })
    const before = (await getAgentIntegration(id))!
    expect(await requireIntegrationReconnect({ integrationId: id, expectedConfig: before.config, config: {}, message: 'Reconnect' })).toBe(true)
    expect(await stateOf('fresh')).toBe('pending')
  })

  it('sends nothing for a credential refresh, and a loss for the rejection of the refreshed one', async () => {
    const tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000, scope: 'read' }
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: { redirectUri: 'https://app.test/callback', tokens, authorizationVersion: 'v1' } })
    const observed = await observe(id)
    await updateLinearConfig(id, current => ({ ...current, tokens: { ...tokens, accessToken: 'access-2', refreshToken: 'refresh-2' } }))
    await backgroundSettled()
    expect(observed).toEqual([])
    expect((await getAgentIntegration(id))?.status).toBe('active')

    // The rejection of the credential the refresh replaced changes nothing.
    await revokeLinearAuthorization(id, { accessToken: 'access-1', authorizationVersion: 'v1' })
    await backgroundSettled()
    expect(observed).toEqual([])
    await revokeLinearAuthorization(id, { accessToken: 'access-2', authorizationVersion: 'v1' })
    await backgroundSettled()
    expect(observed).toEqual([{ type: 'authorization_lost', integrationId: id, version: (await getAgentIntegration(id))!.version }])
    expect((await getAgentIntegration(id))?.status).toBe('disconnected')
  })
})
