import { describe, expect, it } from 'vitest'
import { pruneExpiredApiLogsForAgent, type ApiLogAutoDeleteDb } from './api-log-auto-delete'

interface Row {
  id: string
  agentSlug: string
  createdAt: number
}

function fakeDb(tables: { proxy: Row[]; mcp: Row[] }): ApiLogAutoDeleteDb {
  return {
    prepare(sql: string) {
      const table = sql.includes('proxy_audit_log') ? tables.proxy : tables.mcp
      return {
        run(agentSlug: unknown, cutoffMs: unknown, limit: unknown) {
          const slug = String(agentSlug)
          const cutoff = Number(cutoffMs)
          const batch = Number(limit)
          const matches = table.filter(
            (row) => row.agentSlug === slug && row.createdAt < cutoff,
          )
          const toDelete = new Set(matches.slice(0, batch).map((row) => row.id))
          const remaining = table.filter((row) => !toDelete.has(row.id))
          table.length = 0
          table.push(...remaining)
          return { changes: toDelete.size }
        },
      }
    },
  }
}

describe('pruneExpiredApiLogsForAgent', () => {
  it('deletes only rows older than the cutoff for that agent', async () => {
    const cutoff = Date.UTC(2026, 7, 1)
    const tables = {
      proxy: [
        { id: 'p-old', agentSlug: 'agent-a', createdAt: cutoff - 1 },
        { id: 'p-new', agentSlug: 'agent-a', createdAt: cutoff },
        { id: 'p-other', agentSlug: 'agent-b', createdAt: cutoff - 1 },
      ],
      mcp: [
        { id: 'm-old', agentSlug: 'agent-a', createdAt: cutoff - 1 },
        { id: 'm-new', agentSlug: 'agent-a', createdAt: cutoff + 1 },
      ],
    }

    const result = await pruneExpiredApiLogsForAgent(fakeDb(tables), 'agent-a', cutoff)

    expect(result).toEqual({ proxyDeleted: 1, mcpDeleted: 1 })
    expect(tables.proxy.map((row) => row.id)).toEqual(['p-new', 'p-other'])
    expect(tables.mcp.map((row) => row.id)).toEqual(['m-new'])
  })

  it('batches deletes until the cutoff window is empty', async () => {
    const tables = {
      proxy: [
        { id: 'p1', agentSlug: 'agent-a', createdAt: 1 },
        { id: 'p2', agentSlug: 'agent-a', createdAt: 2 },
        { id: 'p3', agentSlug: 'agent-a', createdAt: 3 },
      ],
      mcp: [{ id: 'm1', agentSlug: 'agent-a', createdAt: 1 }],
    }

    const result = await pruneExpiredApiLogsForAgent(fakeDb(tables), 'agent-a', 1_000, 2)

    expect(result).toEqual({ proxyDeleted: 3, mcpDeleted: 1 })
    expect(tables.proxy).toEqual([])
    expect(tables.mcp).toEqual([])
  })

  it('stops at maxBatches even if the db keeps reporting deletions', async () => {
    let runs = 0
    const neverEmptyDb: ApiLogAutoDeleteDb = {
      prepare() {
        return {
          run() {
            runs++
            return { changes: 2 }
          },
        }
      },
    }

    const result = await pruneExpiredApiLogsForAgent(neverEmptyDb, 'agent-a', 1_000, 2, 3)

    expect(runs).toBe(6)
    expect(result).toEqual({ proxyDeleted: 6, mcpDeleted: 6 })
  })
})
