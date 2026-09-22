import { sql } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'

export const API_LOG_PRUNE_BATCH_SIZE = 5_000
// Caps a single prune run at maxBatches * batchSize rows per table; anything
// beyond that is picked up by the monitor's next cycle.
export const API_LOG_PRUNE_MAX_BATCHES = 200

const PRUNE_TABLES = ['proxy_audit_log', 'mcp_audit_log'] as const

type PruneTable = (typeof PRUNE_TABLES)[number]

function pruneStatement(table: PruneTable, agentSlug: string, cutoffMs: number, batchSize: number) {
  const name = sql.identifier(table)
  return sql`DELETE FROM ${name} WHERE id IN (SELECT id FROM ${name} WHERE agent_slug = ${agentSlug} AND created_at < ${cutoffMs} LIMIT ${batchSize})`
}

/**
 * Delete an agent's audit rows older than `cutoffMs`, in slices of
 * `batchSize` with a turn of the event loop between them, so a large backlog
 * never holds the connection for one long statement.
 */
export async function pruneExpiredApiLogsForAgent(
  db: AppDatabase,
  agentSlug: string,
  cutoffMs: number,
  batchSize = API_LOG_PRUNE_BATCH_SIZE,
  maxBatches = API_LOG_PRUNE_MAX_BATCHES,
): Promise<{ proxyDeleted: number; mcpDeleted: number }> {
  let proxyDeleted = 0
  let mcpDeleted = 0

  for (const table of PRUNE_TABLES) {
    for (let batch = 0; batch < maxBatches; batch++) {
      const changes = changesOf(await db.run(pruneStatement(table, agentSlug, cutoffMs, batchSize)))
      if (changes === 0) break
      if (table === 'proxy_audit_log') proxyDeleted += changes
      else mcpDeleted += changes
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  return { proxyDeleted, mcpDeleted }
}
