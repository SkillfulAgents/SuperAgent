import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { appState } from '@shared/lib/app-state'
import { connectedAccounts, proxyRules, remoteMcpServers } from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import { RULE_CACHE_TTL_MS } from './rule-cache'
import { addRuleVersion, createRule, deleteRule, invalidateRuleCache, listActiveRules, type RuleTarget, type SavedRuleVersionInput } from './store'

const ACCOUNT: RuleTarget = { kind: 'api', targetId: 'acct-1' }
const MCP: RuleTarget = { kind: 'mcp', targetId: 'mcp-1' }

function version(name: string): SavedRuleVersionInput {
  return {
    effect: 'allow', name, description: name, restatement: name, patterns: ['GET /*'], code: '() => true',
    tests: [], warnings: [], toolSchemaHash: null,
  }
}

async function saveRule(target: RuleTarget, name: string, agentSlug: string | null = null) {
  // The clock only moves by hand here, and rules list oldest first.
  vi.setSystemTime(Date.now() + 1)
  const saved = await createRule({ target, agentSlug, createdBy: 'user', createdByAgentSlug: null, version: version(name) })
  if (!saved) throw new Error('rule was not saved')
  return saved
}

/** A second process: its own module state, the same database and AppState. */
async function anotherProcess() {
  vi.resetModules()
  return import('./store')
}

const names = (rules: Array<{ name: string }>) => rules.map((r) => r.name)

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  const now = new Date()
  await testDb.insert(connectedAccounts).values({
    id: ACCOUNT.targetId, providerConnectionId: 'ca_1', toolkitSlug: 'gmail', displayName: 'me', status: 'active', createdAt: now, updatedAt: now,
  }).run()
  await testDb.insert(remoteMcpServers).values({
    id: MCP.targetId, name: 'server', url: 'https://mcp.example.com', status: 'active', createdAt: now, updatedAt: now,
  }).run()
  // Date only: AppState's clock moves by hand, and the database runs as usual.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await handle.close()
})

describe('listActiveRules', () => {
  it('filters the shared snapshot per agent', async () => {
    await saveRule(ACCOUNT, 'everyone')
    await saveRule(ACCOUNT, 'only-a', 'agent-a')
    expect(names(await listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['everyone', 'only-a'])
    expect(names(await listActiveRules(ACCOUNT, 'agent-b'))).toEqual(['everyone'])
  })

  it('reads the database once, however many requests and agents it serves', async () => {
    await saveRule(ACCOUNT, 'everyone')
    await listActiveRules(ACCOUNT, 'agent-a')
    const select = vi.spyOn(testDb, 'select')
    await listActiveRules(ACCOUNT, 'agent-a')
    await listActiveRules(ACCOUNT, 'agent-b')
    expect(select).not.toHaveBeenCalled()
  })
})

describe('a write in one process, a read in another', () => {
  it('sees a created rule at once, with no hint delivered', async () => {
    vi.spyOn(appState(), 'publish').mockRejectedValue(new Error('hints are down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const other = await anotherProcess()
    expect(await other.listActiveRules(ACCOUNT, 'agent-a')).toEqual([])

    await saveRule(ACCOUNT, 'new')

    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['new'])
  })

  it('sees a new version at once', async () => {
    const saved = await saveRule(ACCOUNT, 'v1')
    const other = await anotherProcess()
    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['v1'])

    await addRuleVersion(saved.rule.id, version('v2'))

    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['v2'])
  })

  it('sees a delete at once', async () => {
    const saved = await saveRule(ACCOUNT, 'gone')
    const other = await anotherProcess()
    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['gone'])

    expect(await deleteRule(saved.rule.id)).toBe(true)

    expect(await other.listActiveRules(ACCOUNT, 'agent-a')).toEqual([])
  })

  it('invalidates only the target that changed', async () => {
    const saved = await saveRule(ACCOUNT, 'account-rule')
    await saveRule(MCP, 'mcp-rule')
    await listActiveRules(ACCOUNT, 'agent-a')
    await listActiveRules(MCP, 'agent-a')
    const select = vi.spyOn(testDb, 'select')

    await deleteRule(saved.rule.id)
    select.mockClear()

    expect(names(await listActiveRules(MCP, 'agent-a'))).toEqual(['mcp-rule'])
    expect(select).not.toHaveBeenCalled()
  })

  it('invalidates every target when no target is named', async () => {
    await saveRule(ACCOUNT, 'account-rule')
    await saveRule(MCP, 'mcp-rule')
    const other = await anotherProcess()
    await other.listActiveRules(ACCOUNT, 'agent-a')
    await other.listActiveRules(MCP, 'agent-a')

    // What agent cleanup does: a direct delete, then the invalidation.
    await testDb.delete(proxyRules).run()
    await invalidateRuleCache()

    expect(await other.listActiveRules(ACCOUNT, 'agent-a')).toEqual([])
    expect(await other.listActiveRules(MCP, 'agent-a')).toEqual([])
  })

  it('a change the store never heard about shows within the ceiling', async () => {
    const saved = await saveRule(ACCOUNT, 'cascaded')
    const other = await anotherProcess()
    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['cascaded'])

    await testDb.delete(proxyRules).where(eq(proxyRules.id, saved.rule.id)).run()

    vi.setSystemTime(Date.now() + RULE_CACHE_TTL_MS - 1)
    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['cascaded'])
    vi.setSystemTime(Date.now() + 1)
    expect(await other.listActiveRules(ACCOUNT, 'agent-a')).toEqual([])
  })
})

describe('a failed invalidation after the database committed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('does not fail the write, and the ceiling bounds the staleness', async () => {
    const other = await anotherProcess()
    expect(await other.listActiveRules(ACCOUNT, 'agent-a')).toEqual([])
    vi.spyOn(appState(), 'set').mockRejectedValue(new Error('AppState is down'))

    const saved = await saveRule(ACCOUNT, 'new')
    const edited = await addRuleVersion(saved.rule.id, version('new-2'))

    expect(saved.version.name).toBe('new')
    expect(edited?.version.name).toBe('new-2')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not invalidate'), expect.any(Error))
    vi.setSystemTime(Date.now() + RULE_CACHE_TTL_MS)
    expect(names(await other.listActiveRules(ACCOUNT, 'agent-a'))).toEqual(['new-2'])
  })

  it('a delete still reports what it did', async () => {
    const saved = await saveRule(ACCOUNT, 'gone')
    vi.spyOn(appState(), 'set').mockRejectedValue(new Error('AppState is down'))
    expect(await deleteRule(saved.rule.id)).toBe(true)
    expect(await deleteRule(saved.rule.id)).toBe(false)
  })
})

it('a delete that deleted nothing, or an edit that lost, invalidates nothing', async () => {
  const saved = await saveRule(ACCOUNT, 'kept')
  await listActiveRules(ACCOUNT, 'agent-a')
  const set = vi.spyOn(appState(), 'set')

  expect(await deleteRule(saved.rule.id, 'another-version')).toBe(false)
  expect(await addRuleVersion(saved.rule.id, version('late'), 'another-version')).toBeNull()

  expect(set).not.toHaveBeenCalled()
})
