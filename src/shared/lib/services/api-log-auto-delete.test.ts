import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asc } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { mcpAuditLog, proxyAuditLog } from '@shared/lib/db/schema'
import { pruneExpiredApiLogsForAgent } from './api-log-auto-delete'

let handle: TestDatabase

beforeEach(async () => {
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
})

function proxyRow(id: string, agentSlug: string, createdAt: number) {
  return {
    id,
    agentSlug,
    accountId: 'acct',
    toolkit: 'gmail',
    targetHost: 'example.test',
    targetPath: '/',
    method: 'GET',
    createdAt: new Date(createdAt),
  }
}

function mcpRow(id: string, agentSlug: string, createdAt: number) {
  return {
    id,
    agentSlug,
    remoteMcpId: 'mcp',
    remoteMcpName: 'MCP',
    method: 'tools/call',
    requestPath: '/',
    createdAt: new Date(createdAt),
  }
}

async function proxyIds() {
  const rows = await handle.db.select({ id: proxyAuditLog.id }).from(proxyAuditLog).orderBy(asc(proxyAuditLog.id)).all()
  return rows.map((row) => row.id)
}

async function mcpIds() {
  const rows = await handle.db.select({ id: mcpAuditLog.id }).from(mcpAuditLog).orderBy(asc(mcpAuditLog.id)).all()
  return rows.map((row) => row.id)
}

describe('pruneExpiredApiLogsForAgent', () => {
  it('deletes only rows older than the cutoff for that agent', async () => {
    const cutoff = Date.UTC(2026, 7, 1)
    await handle.db.insert(proxyAuditLog).values([
      proxyRow('p-old', 'agent-a', cutoff - 1),
      proxyRow('p-new', 'agent-a', cutoff),
      proxyRow('p-other', 'agent-b', cutoff - 1),
    ]).run()
    await handle.db.insert(mcpAuditLog).values([
      mcpRow('m-old', 'agent-a', cutoff - 1),
      mcpRow('m-new', 'agent-a', cutoff + 1),
    ]).run()

    const result = await pruneExpiredApiLogsForAgent(handle.db, 'agent-a', cutoff)

    expect(result).toEqual({ proxyDeleted: 1, mcpDeleted: 1 })
    expect(await proxyIds()).toEqual(['p-new', 'p-other'])
    expect(await mcpIds()).toEqual(['m-new'])
  })

  it('batches deletes until the cutoff window is empty', async () => {
    await handle.db.insert(proxyAuditLog).values([
      proxyRow('p1', 'agent-a', 1),
      proxyRow('p2', 'agent-a', 2),
      proxyRow('p3', 'agent-a', 3),
    ]).run()
    await handle.db.insert(mcpAuditLog).values([mcpRow('m1', 'agent-a', 1)]).run()

    const result = await pruneExpiredApiLogsForAgent(handle.db, 'agent-a', 1_000, 2)

    expect(result).toEqual({ proxyDeleted: 3, mcpDeleted: 1 })
    expect(await proxyIds()).toEqual([])
    expect(await mcpIds()).toEqual([])
  })

  it('stops at maxBatches and leaves the rest for the next cycle', async () => {
    await handle.db.insert(proxyAuditLog).values(
      Array.from({ length: 10 }, (_, i) => proxyRow(`p${i}`, 'agent-a', i)),
    ).run()
    await handle.db.insert(mcpAuditLog).values(
      Array.from({ length: 10 }, (_, i) => mcpRow(`m${i}`, 'agent-a', i)),
    ).run()

    const result = await pruneExpiredApiLogsForAgent(handle.db, 'agent-a', 1_000, 2, 3)

    expect(result).toEqual({ proxyDeleted: 6, mcpDeleted: 6 })
    expect(await proxyIds()).toHaveLength(4)
    expect(await mcpIds()).toHaveLength(4)
  })
})
