import { db } from '@shared/lib/db'
import { auditLog, user, type AuditLogEntry } from '@shared/lib/db/schema'
import { desc, and, eq, count, isNotNull, inArray, type SQL } from 'drizzle-orm'

export type { AuditLogEntry }

export const AUDIT_EVENT_MAP = {
  agent:            ['created', 'updated', 'deleted', 'imported', 'exported'],
  agent_access:     ['granted', 'revoked', 'changed'],
  account:          ['connected', 'disconnected', 'assigned', 'unassigned'],
  mcp:              ['created', 'updated', 'deleted', 'assigned', 'unassigned'],
  trigger:          ['created', 'updated', 'deleted', 'paused', 'resumed'],
  task:             ['created', 'updated', 'deleted', 'paused', 'resumed'],
  chat_integration: ['created', 'updated', 'deleted'],
  skill:            ['created', 'updated', 'deleted', 'exported'],
  secret:           ['created', 'updated', 'deleted'],
  file:             ['uploaded'],
  mount:            ['created', 'deleted'],
  settings:         ['updated', 'factory_reset'],
  policy:           ['updated'],
  user:             ['invited', 'reset_password'],
} as const satisfies Record<string, readonly string[]>

export type AuditObject = keyof typeof AUDIT_EVENT_MAP
export type AuditAction = typeof AUDIT_EVENT_MAP[AuditObject][number]

export const AUDIT_OBJECTS = Object.keys(AUDIT_EVENT_MAP) as AuditObject[]
export const AUDIT_ACTIONS = [...new Set(Object.values(AUDIT_EVENT_MAP).flat())] as AuditAction[]

type AuditEventFor<O extends AuditObject> = typeof AUDIT_EVENT_MAP[O][number]

export type LogAuditEventParams = {
  [O in AuditObject]: {
    userId?: string | null
    object: O
    objectId: string
    action: AuditEventFor<O>
    details?: Record<string, unknown>
  }
}[AuditObject]

export async function logAuditEvent(params: LogAuditEventParams): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId: params.userId ?? null,
      object: params.object,
      objectId: params.objectId,
      action: params.action,
      details: params.details ? JSON.stringify(params.details) : null,
      createdAt: new Date(),
    })
  } catch (error) {
    console.error('[audit] Failed to write audit log:', error)
  }
}

export interface AuditLogQuery {
  object?: string
  action?: string
  userId?: string
  limit?: number
  offset?: number
}

export interface AuditLogPage {
  entries: AuditLogEntry[]
  total: number
  limit: number
  offset: number
}

export async function queryAuditLog(query: AuditLogQuery): Promise<AuditLogPage> {
  const limit = Math.min(query.limit ?? 50, 100)
  const offset = query.offset ?? 0

  const conditions: SQL[] = []
  if (query.object) conditions.push(eq(auditLog.object, query.object))
  if (query.action) conditions.push(eq(auditLog.action, query.action))
  if (query.userId) conditions.push(eq(auditLog.userId, query.userId))

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [entries, totalResult] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(auditLog)
      .where(where),
  ])

  return {
    entries,
    total: totalResult[0]?.count ?? 0,
    limit,
    offset,
  }
}

export async function getDistinctAuditUsers(): Promise<Array<{ id: string; name: string; email: string }>> {
  const rows = await db
    .selectDistinct({ userId: auditLog.userId })
    .from(auditLog)
    .where(isNotNull(auditLog.userId))

  const userIds = rows.map(r => r.userId).filter((id): id is string => id !== null && id !== 'local')
  if (userIds.length === 0) return []

  return db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, userIds))
}
