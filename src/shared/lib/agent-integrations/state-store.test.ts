import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { chatIntegrations, integrationState } from '../db/schema'
import { readIntegrationState, writeIntegrationState, replaceIntegrationState, deleteIntegrationState, listIntegrationStateKeys } from './state-store'
let handle: TestDatabase, database: AppDatabase
vi.mock('../db', () => ({ get db() { return database } }))
beforeEach(async () => {
  handle = await createTestDatabase(); database = handle.db
  for (const id of ['a', 'b']) await database.insert(chatIntegrations).values({ id, agentSlug: id, provider: 'slack', config: '{}', createdAt: new Date(), updatedAt: new Date() }).run()
})
afterEach(async () => { await handle.close() })
it('isolates identical keys by installation for reads, writes, listings and deletes', async () => {
  await writeIntegrationState('a', 'cursor', z.number(), 10)
  await writeIntegrationState('b', 'cursor', z.number(), 20)
  await writeIntegrationState('a', 'cursor', z.number(), 11)
  expect(await readIntegrationState('a', 'cursor', z.number())).toBe(11)
  expect(await readIntegrationState('b', 'cursor', z.number())).toBe(20)
  await deleteIntegrationState('a', 'cursor')
  expect(await listIntegrationStateKeys('a')).toEqual([])
  expect(await listIntegrationStateKeys('b')).toEqual([{ key: 'cursor' }])
})
it('validates both writes and persisted reads without exposing corrupt payloads', async () => {
  await expect(writeIntegrationState('a', 'cursor', z.number(), 'bad' as never)).rejects.toThrow()
  expect(await listIntegrationStateKeys('a')).toEqual([])
  await writeIntegrationState('a', 'cursor', z.number(), 10)
  await database.update(integrationState).set({ value: 'not-json' }).run()
  await expect(readIntegrationState('a', 'cursor', z.number())).rejects.toThrow('Invalid persisted integration state')
})
it('permits only one concurrent compare-and-set claim and leaves other installations alone', async () => {
  const schema = z.enum(['held', 'approved'])
  await writeIntegrationState('a', 'review', schema, 'held')
  await writeIntegrationState('b', 'review', schema, 'held')
  const results = await Promise.all([1, 2].map(() => replaceIntegrationState('a', 'review', schema, 'held', 'approved')))
  expect(results.sort()).toEqual([false, true])
  expect(await readIntegrationState('b', 'review', schema)).toBe('held')
})
it('uses literal prefixes, bounded results and generic due metadata rather than inspecting payloads', async () => {
  await writeIntegrationState('a', 'job_1', z.string(), 'ready', { availableAt: 10 })
  await writeIntegrationState('a', 'job_2', z.string(), 'later', { availableAt: 30 })
  await writeIntegrationState('a', 'job%3', z.string(), 'ready', { availableAt: 5 })
  await writeIntegrationState('a', 'jobX4', z.string(), 'unscheduled')
  await writeIntegrationState('b', 'job_5', z.string(), 'other', { availableAt: 1 })
  expect(await listIntegrationStateKeys('a', { prefix: 'job_', readyBefore: 20 })).toEqual([{ key: 'job_1' }])
  expect(await listIntegrationStateKeys('a', { prefix: 'job%', readyBefore: 20 })).toEqual([{ key: 'job%3' }])
  expect(await listIntegrationStateKeys('a', { readyBefore: 100, limit: 1 })).toEqual([{ key: 'job%3' }])
})
it('cascades state deletion through the shared installation lifecycle', async () => {
  await writeIntegrationState('a', 'state', z.string(), 'a')
  await writeIntegrationState('b', 'state', z.string(), 'b')
  await database.delete(chatIntegrations).where(eq(chatIntegrations.id, 'a')).run()
  expect(await readIntegrationState('a', 'state', z.string())).toBeNull()
  expect(await readIntegrationState('b', 'state', z.string())).toBe('b')
})
