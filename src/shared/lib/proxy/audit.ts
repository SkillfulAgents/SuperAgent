import crypto from 'node:crypto'
import { db } from '@shared/lib/db'
import { proxyAuditLog } from '@shared/lib/db/schema'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

export interface ProxyAuditEntry {
  agentSlug: string
  accountId: string
  toolkit: string
  targetHost: string
  targetPath: string
  method: string
  statusCode?: number
  errorMessage?: string
  policyDecision?: string
  matchedScopes?: string
}

export async function writeProxyAuditEntry(entry: ProxyAuditEntry & { durationMs?: number }, options: { analytics?: boolean } = {}): Promise<void> {
  try {
    await db.insert(proxyAuditLog).values({
      id: crypto.randomUUID(),
      ...entry,
      statusCode: entry.statusCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      durationMs: entry.durationMs ?? null,
      policyDecision: entry.policyDecision ?? null,
      matchedScopes: entry.matchedScopes ?? null,
      createdAt: new Date(),
    })
    if (options.analytics !== false) trackServerEvent('api_called', { slug: entry.toolkit })
  } catch (error) {
    console.error('[proxy] Failed to write audit log:', error)
  }
}
