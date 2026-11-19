// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agentCatalog } from '@shared/lib/agent-actor'
import { completeAgentCreation, reserveAgentCreation } from './agent-creation-request'

let handle: TestDatabase
let dir: string
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'creation-receipt-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dir)
  handle = await createTestDatabase({ file: join(dir, 'test.db') })
})
afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

const input = { name: 'Scout' }
it('keeps one agent per user and request when callers race', async () => {
  const reserve = () => reserveAgentCreation('alice', 'setup', input, false)
  const [first, second] = await Promise.all([reserve(), reserve()])
  expect(second.value.slug).toBe(first.value.slug)
  expect(await Promise.all([completeAgentCreation(first), completeAgentCreation(second)])).toContain(false)
  expect(await agentCatalog.list()).toEqual([first.value.slug])
  expect((await reserveAgentCreation('bob', 'setup', input, false)).value.slug).not.toBe(first.value.slug)
})

it('can finish an interrupted create after reopening the database and recognizes completed replays', async () => {
  const reserved = await reserveAgentCreation('alice', 'setup', input, false)
  const reopen = async () => {
    await handle.close()
    handle = await createTestDatabase({ file: join(dir, 'test.db') })
  }
  await reopen()
  const resumed = await reserveAgentCreation('alice', 'setup', input, false)
  expect(resumed.value).toEqual({ slug: reserved.value.slug, ready: false })
  expect(await completeAgentCreation(resumed)).toBe(true)
  await reopen()
  expect((await reserveAgentCreation('alice', 'setup', input, false)).value).toEqual({ slug: reserved.value.slug, ready: true })
  expect(await agentCatalog.list()).toEqual([reserved.value.slug])
})

it('rolls back the receipt and agent if the owner cannot be recorded', async () => {
  await expect(reserveAgentCreation('missing-user', 'setup', input, true)).rejects.toThrow()
  expect(await agentCatalog.list()).toEqual([])
  const retry = await reserveAgentCreation('missing-user', 'setup', input, false)
  expect(await agentCatalog.list()).toEqual([retry.value.slug])
})
