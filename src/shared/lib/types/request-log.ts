import type { McpAuditLogEntry, ProxyAuditLogEntry } from '@shared/lib/db/schema'

export interface RequestLogEntry {
  id: string
  source: 'proxy' | 'mcp'
  agentSlug: string
  label: string
  targetUrl: string
  method: string
  statusCode: number | null
  errorMessage: string | null
  durationMs: number | null
  policyDecision: string | null
  matchedScopes: string | null
  /** Date on the server; ISO string after JSON transport. */
  createdAt: Date | string
}

export interface RequestLogPage {
  entries: RequestLogEntry[]
  total: number
}

export function normalizeProxyRequestLog(entry: ProxyAuditLogEntry): RequestLogEntry {
  return {
    id: entry.id,
    source: 'proxy',
    agentSlug: entry.agentSlug,
    label: entry.toolkit,
    targetUrl: `${entry.targetHost}/${entry.targetPath}`,
    method: entry.method,
    statusCode: entry.statusCode ?? null,
    errorMessage: entry.errorMessage ?? null,
    durationMs: entry.durationMs ?? null,
    policyDecision: entry.policyDecision ?? null,
    matchedScopes: entry.matchedScopes ?? null,
    createdAt: entry.createdAt,
  }
}

export function normalizeMcpRequestLog(entry: McpAuditLogEntry): RequestLogEntry {
  return {
    id: entry.id,
    source: 'mcp',
    agentSlug: entry.agentSlug,
    label: entry.remoteMcpName,
    targetUrl: entry.requestPath,
    method: entry.method,
    statusCode: entry.statusCode ?? null,
    errorMessage: entry.errorMessage ?? null,
    durationMs: entry.durationMs ?? null,
    policyDecision: entry.policyDecision ?? null,
    matchedScopes: entry.matchedTool ? JSON.stringify([entry.matchedTool]) : null,
    createdAt: entry.createdAt,
  }
}
