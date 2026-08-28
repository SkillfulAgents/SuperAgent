export const API_LOG_PRUNE_BATCH_SIZE = 5_000

const PRUNE_TABLES = ['proxy_audit_log', 'mcp_audit_log'] as const

type PruneTable = (typeof PRUNE_TABLES)[number]

export interface ApiLogAutoDeleteDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
  }
}

function pruneSql(table: PruneTable): string {
  return `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE agent_slug = ? AND created_at < ? LIMIT ?)`
}

export async function pruneExpiredApiLogsForAgent(
  db: ApiLogAutoDeleteDb,
  agentSlug: string,
  cutoffMs: number,
  batchSize = API_LOG_PRUNE_BATCH_SIZE,
): Promise<{ proxyDeleted: number; mcpDeleted: number }> {
  let proxyDeleted = 0
  let mcpDeleted = 0

  for (const table of PRUNE_TABLES) {
    const stmt = db.prepare(pruneSql(table))
    for (;;) {
      const { changes } = stmt.run(agentSlug, cutoffMs, batchSize)
      if (changes === 0) break
      if (table === 'proxy_audit_log') proxyDeleted += changes
      else mcpDeleted += changes
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  return { proxyDeleted, mcpDeleted }
}
