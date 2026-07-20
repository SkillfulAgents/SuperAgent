import { Hono } from 'hono'
import { and, count, desc, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import {
  connectedAccounts,
  mcpAuditLog,
  proxyAuditLog,
  remoteMcpServers,
} from '@shared/lib/db/schema'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import {
  normalizeMcpRequestLog,
  normalizeProxyRequestLog,
} from '@shared/lib/types/request-log'
import { Authenticated } from '../middleware/auth'

const connectionLogsRouter = new Hono()

connectionLogsRouter.use('*', Authenticated())

function parsePagination(rawOffset: string | undefined, rawLimit: string | undefined) {
  const parsedOffset = Number.parseInt(rawOffset ?? '0', 10)
  const parsedLimit = Number.parseInt(rawLimit ?? '20', 10)
  return {
    offset: Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0,
    limit: Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20,
  }
}

/**
 * Connection-wide request logs. Ownership is checked against the selected
 * account/server before its append-only audit rows are queried.
 */
connectionLogsRouter.get('/:kind/:id', async (c) => {
  try {
    const kind = c.req.param('kind')
    if (kind !== 'account' && kind !== 'mcp') {
      return c.json({ error: 'Invalid connection kind' }, 400)
    }

    const id = c.req.param('id')
    const ownerId = getViewerUserId(c)
    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    if (kind === 'account') {
      const [account] = await db
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(and(
          eq(connectedAccounts.id, id),
          ownerId ? eq(connectedAccounts.userId, ownerId) : undefined,
        ))
        .limit(1)

      if (!account) return c.json({ error: 'Connection not found' }, 404)

      const [entries, totalResult] = await Promise.all([
        db
          .select()
          .from(proxyAuditLog)
          .where(eq(proxyAuditLog.accountId, id))
          .orderBy(desc(proxyAuditLog.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: count() })
          .from(proxyAuditLog)
          .where(eq(proxyAuditLog.accountId, id)),
      ])

      return c.json({
        entries: entries.map(normalizeProxyRequestLog),
        total: totalResult[0]?.count ?? 0,
      })
    }

    const [server] = await db
      .select({ id: remoteMcpServers.id })
      .from(remoteMcpServers)
      .where(and(
        eq(remoteMcpServers.id, id),
        ownerId ? eq(remoteMcpServers.userId, ownerId) : undefined,
      ))
      .limit(1)

    if (!server) return c.json({ error: 'Connection not found' }, 404)

    const [entries, totalResult] = await Promise.all([
      db
        .select()
        .from(mcpAuditLog)
        .where(eq(mcpAuditLog.remoteMcpId, id))
        .orderBy(desc(mcpAuditLog.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(mcpAuditLog)
        .where(eq(mcpAuditLog.remoteMcpId, id)),
    ])

    return c.json({
      entries: entries.map(normalizeMcpRequestLog),
      total: totalResult[0]?.count ?? 0,
    })
  } catch (error) {
    console.error('Failed to fetch connection request logs:', error)
    return c.json({ error: 'Failed to fetch request logs' }, 500)
  }
})

export default connectionLogsRouter
