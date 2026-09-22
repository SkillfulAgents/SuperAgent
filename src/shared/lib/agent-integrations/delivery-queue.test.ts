import { MessageNotAcceptedError } from '../container/message-dispatch-error'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations, integrationDeliveries } from '../db/schema'
import { deliveryStore, DELIVERY_RETENTION_MS, type DeliveryRecord } from './delivery-store'
import { IntegrationDeliveryQueue, PermanentDeliveryError, type DeliveryAttempt } from './delivery-queue'
import { deliveryEnvelopeSchema } from './delivery-schema'
import type { IntegrationInputEvent } from './types'
let database: AppDatabase
let handle: TestDatabase
vi.mock('../db', () => ({ get db() { return database } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
const event = (id = 'event', externalId = 'conversation'): IntegrationInputEvent => ({ type: 'input', id, externalId, timestamp: new Date(), payload: { text: 'hello' } })
const route = { externalId: 'conversation', action: 'run' as const, replyTarget: { commentId: 'thread' } }
let queues: IntegrationDeliveryQueue[]
let available: boolean
let dispatch: ReturnType<typeof vi.fn<(row: DeliveryRecord, attempt: DeliveryAttempt) => Promise<void>>>
let reconcile: ReturnType<typeof vi.fn<(row: DeliveryRecord) => Promise<boolean>>>
let notice: ReturnType<typeof vi.fn<(row: DeliveryRecord) => Promise<void>>>
function queue() {
  const result = new IntegrationDeliveryQueue({ connectedIds: () => available ? ['integration'] : [], dispatch, reconcile, notice })
  queues.push(result); return result
}
async function rows() { return database.select().from(integrationDeliveries).all() }
async function settled(expected: Partial<DeliveryRecord>) { await vi.waitFor(async () => expect((await rows())[0]).toMatchObject(expected)) }
async function expireBackoff() { await database.update(integrationDeliveries).set({ nextAttemptAt: new Date(0) }).run(); queues.at(-1)!.wake() }
beforeEach(async () => {
  handle = await createTestDatabase(); database = handle.db
  queues = []; available = true
  dispatch = vi.fn(async (_row, attempt) => { await attempt.handoff('runtime-session', async () => {}) })
  reconcile = vi.fn(async () => false); notice = vi.fn(async () => {})
  await database.insert(chatIntegrations).values({ id: 'integration', provider: 'slack', agentSlug: 'agent', config: '{}', createdAt: new Date(), updatedAt: new Date() }).run()
})
afterEach(async () => { queues.forEach(q => q.stop()); await new Promise(resolve => setTimeout(resolve, 10)); await handle.close() })

describe('durable integration delivery (common SQL path)', () => {
  it.each(['slack', 'telegram', 'imessage', 'linear'] as const)('persists and deduplicates stable event IDs for %s across restarts', async provider => {
    await database.update(chatIntegrations).set({ provider }).run()
    const first = queue()
    await first.accept('integration', event(), route) // killed before dispatch
    expect(dispatch).not.toHaveBeenCalled()
    expect((await rows())[0].state).toBe('pending')
    const restarted = queue(); await restarted.start()
    await settled({ state: 'delivered' })
    expect(dispatch).toHaveBeenCalledOnce()
    await restarted.accept('integration', event(), route)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(dispatch).toHaveBeenCalledOnce()
    expect(await rows()).toHaveLength(1)
  })
  it('recovers an interrupted preparation, retaining its attempt budget', async () => {
    await deliveryStore.accept('integration', event(), route)
    const row = (await rows())[0]
    await deliveryStore.claim(row, 'dead-host', false)
    await queue().start()
    await settled({ state: 'delivered', attempts: 2 })
  })
  it('does not replay after runtime acceptance when the host dies before recording success', async () => {
    await deliveryStore.accept('integration', event(), route)
    const row = (await rows())[0]
    await deliveryStore.claim(row, 'dead-host', false)
    await deliveryStore.handoff(row.id, 'dead-host', 'runtime-session')
    reconcile.mockResolvedValue(true)
    await queue().start()
    await settled({ state: 'delivered', sessionId: 'runtime-session' })
    expect(reconcile).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
  })
  it('settles an ambiguous handoff explicitly without replaying side-effecting work', async () => {
    dispatch.mockImplementation(async (_row, attempt) => { await attempt.handoff('runtime-session', async () => { throw new Error('response lost') }) })
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await settled({ state: 'uncertain', noticeState: 'sent' })
    expect(dispatch).toHaveBeenCalledOnce(); expect(notice).toHaveBeenCalledOnce()
    q.stop(); await queue().start()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('retries preparation with bounded backoff and survives a restart during the delay', async () => {
    dispatch.mockRejectedValueOnce(new Error('container offline'))
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await settled({ state: 'pending', attempts: 1 })
    expect((await rows())[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
    q.stop(); await queue().start(); await expireBackoff()
    await settled({ state: 'delivered', attempts: 2 })
  })
  it('caps dispatch and failure-notice retries independently', async () => {
    dispatch.mockRejectedValue(new Error('offline')); notice.mockRejectedValue(new Error('provider unavailable'))
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    for (let attempts = 1; attempts <= 5; attempts++) {
      await settled({ attempts, state: attempts === 5 ? 'failed' : 'pending' })
      if (attempts < 5) await expireBackoff()
    }
    for (let noticeAttempts = 1; noticeAttempts <= 5; noticeAttempts++) {
      await settled({ noticeAttempts, noticeState: noticeAttempts === 5 ? 'failed' : 'pending' })
      if (noticeAttempts < 5) await expireBackoff()
    }
    expect(dispatch).toHaveBeenCalledTimes(5); expect(notice).toHaveBeenCalledTimes(5)
    expect((await rows())[0].envelope).toBeNull()
  })
  it('does not retry permanent validation failures and restores the original notice route', async () => {
    dispatch.mockRejectedValue(new PermanentDeliveryError('invalid input'))
    notice.mockImplementationOnce(async () => { throw new Error('temporary outage') })
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await settled({ state: 'failed', noticeState: 'pending', noticeAttempts: 1 })
    q.stop(); await queue().start(); await expireBackoff()
    await settled({ noticeState: 'sent', noticeAttempts: 2 })
    expect(deliveryEnvelopeSchema.parse(JSON.parse(notice.mock.calls[1][0].envelope!)).route.replyTarget).toEqual(route.replyTarget)
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('a follow-up is handed off while the previous agent turn is still running', async () => {
    // Handoff acceptance resolves; there is deliberately no turn-completed callback.
    const q = queue(); await q.start()
    await q.accept('integration', event('first'), route)
    await settled({ state: 'delivered' })
    await q.accept('integration', event('second'), route)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect((await rows()).every(row => row.state === 'delivered')).toBe(true)
  })
  it('cancellation while preparing fences the handoff and cannot be resurrected by completion', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => {})
    dispatch.mockImplementation(async (_row, attempt) => { await gate; await attempt.handoff('session', send) })
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await settled({ state: 'preparing' }); await q.cancel('integration', 'conversation')
    release(); await settled({ state: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(send).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled()
  })
  it('deletion cascades accepted work, and inactive installations reject new acceptance', async () => {
    await deliveryStore.accept('integration', event(), route)
    await database.update(chatIntegrations).set({ status: 'paused' }).run()
    expect(await deliveryStore.accept('integration', event('late'), route)).toBe(false)
    await queue().start(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(dispatch).not.toHaveBeenCalled()
    await database.delete(chatIntegrations).run()
    expect(await rows()).toHaveLength(0)
  })
  it('keeps event identity scoped to installation and routed session', async () => {
    await deliveryStore.accept('integration', event(), route)
    await deliveryStore.accept('integration', event(), { ...route, externalId: 'another-conversation' })
    expect(await rows()).toHaveLength(2)
  })
  it('retries a definite pre-acceptance refusal but not an unknown transport failure', async () => {
    dispatch.mockImplementationOnce(async (_row, attempt) => {
      await attempt.handoff('runtime-session', async () => { throw new MessageNotAcceptedError('unavailable', 'not running') })
    })
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await settled({ state: 'pending', attempts: 1 })
    expect(reconcile).not.toHaveBeenCalled()
    await expireBackoff(); await settled({ state: 'delivered', attempts: 2 })
  })
  it('an offline installation with more than a page of pending messages cannot starve a healthy one', async () => {
    await database.insert(chatIntegrations).values({ id: 'offline', provider: 'slack', agentSlug: 'agent', config: '{}', createdAt: new Date(), updatedAt: new Date() }).run()
    for (let i = 0; i < 101; i++) await deliveryStore.accept('offline', event(`offline-${i}`), route)
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(dispatch.mock.calls[0][0].integrationId).toBe('integration')
  })
  it('a slow host notice does not delay a new input to the same conversation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    dispatch.mockRejectedValueOnce(new PermanentDeliveryError('invalid'))
    notice.mockImplementation(async () => { await gate })
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await vi.waitFor(() => expect(notice).toHaveBeenCalledOnce())
    await q.accept('integration', event('follow-up'), route)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    release()
  })
  it('an accepted question answer is settled without starting or replaying a new turn', async () => {
    const answer = vi.fn(async () => true)
    dispatch.mockImplementation(async (_row, attempt) => { expect(await attempt.consume('runtime-session', answer)).toBe(true) })
    const q = queue(); await q.start(); await q.accept('integration', event(), route)
    await settled({ state: 'delivered' })
    q.stop(); await queue().start()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(answer).toHaveBeenCalledOnce()
  })
  it('prunes settled records after seven days but keeps pending work', async () => {
    await deliveryStore.accept('integration', event(), route)
    await deliveryStore.accept('integration', event('old'), route)
    await database.update(integrationDeliveries).set({ updatedAt: new Date(Date.now() - DELIVERY_RETENTION_MS - 1000) }).run()
    await database.update(integrationDeliveries).set({ state: 'delivered' }).where(eq(integrationDeliveries.eventId, 'old')).run()
    await deliveryStore.recover()
    expect(await rows()).toHaveLength(1)
    expect((await rows())[0].eventId).toBe('event')
  })
})
