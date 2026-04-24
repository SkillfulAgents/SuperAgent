import { ArrowLeft, Loader2, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react'
import { Fragment, useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { apiFetch } from '@renderer/lib/api'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useSelection } from '@renderer/context/selection-context'
import { Button } from '@renderer/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@renderer/components/ui/table'
import { useRenderTracker } from '@renderer/lib/perf'

interface AuditLogEntry {
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
  createdAt: string
}

interface ApiLogsViewProps {
  agentSlug: string
}

const PAGE_SIZE = 15

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/40',
    POST: 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/40',
    PUT: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40',
    PATCH: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40',
    DELETE: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/40',
  }
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-2xs font-semibold leading-none ${colors[method] ?? 'text-muted-foreground bg-muted'}`}>
      {method}
    </span>
  )
}

function StatusBadge({ status }: { status: number | null }) {
  if (status === null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const color =
    status >= 200 && status < 300
      ? 'text-green-700 dark:text-green-400'
      : status >= 400
        ? 'text-red-700 dark:text-red-400'
        : 'text-muted-foreground'
  return <span className={`text-xs font-mono font-medium ${color}`}>{status}</span>
}

function SourceBadge({ source }: { source: 'proxy' | 'mcp' }) {
  const style = source === 'mcp'
    ? 'text-purple-700 bg-purple-100 dark:text-purple-300 dark:bg-purple-900/40'
    : 'text-sky-700 bg-sky-100 dark:text-sky-300 dark:bg-sky-900/40'
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-2xs font-semibold leading-none ${style}`}>
      {source === 'mcp' ? 'MCP' : 'API'}
    </span>
  )
}

function PolicyBadge({ decision }: { decision: string | null }) {
  if (!decision) return null
  const styles: Record<string, string> = {
    allow: 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/40',
    approved_by_user: 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/40',
    block: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/40',
    denied_by_user: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/40',
    review_timeout: 'text-orange-700 bg-orange-100 dark:text-orange-300 dark:bg-orange-900/40',
  }
  const labels: Record<string, string> = {
    allow: 'auto-allowed',
    approved_by_user: 'user-approved',
    block: 'auto-blocked',
    denied_by_user: 'user-denied',
    review_timeout: 'timeout',
  }
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-2xs font-semibold leading-none ${styles[decision] ?? 'text-muted-foreground bg-muted'}`}
      title={`Policy: ${decision}`}
    >
      {labels[decision] ?? decision}
    </span>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-24">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  )
}

function EntryDetails({ entry }: { entry: AuditLogEntry }) {
  const scopes: string[] = entry.matchedScopes ? (() => {
    try { return JSON.parse(entry.matchedScopes) } catch { return [] }
  })() : []
  const ts = new Date(entry.createdAt)

  return (
    <div className="text-xs space-y-1.5 pt-1">
      <DetailRow label="Full path" value={<span className="font-mono">{entry.targetUrl}</span>} />
      <DetailRow label="Source" value={entry.source === 'mcp' ? 'MCP Proxy' : 'API Proxy'} />
      <DetailRow label="Toolkit / MCP" value={entry.label} />
      <DetailRow label="Method" value={entry.method} />
      <DetailRow label="Status" value={entry.statusCode ?? '—'} />
      {entry.policyDecision && (
        <DetailRow label="Policy" value={<PolicyBadge decision={entry.policyDecision} />} />
      )}
      {scopes.length > 0 && (
        <DetailRow
          label="Scopes"
          value={
            <div className="flex flex-wrap gap-1">
              {scopes.map((s: string) => (
                <span key={s} className="font-mono bg-muted rounded px-1 py-0.5">{s}</span>
              ))}
            </div>
          }
        />
      )}
      {entry.durationMs !== null && (
        <DetailRow label="Duration" value={`${entry.durationMs}ms`} />
      )}
      {entry.errorMessage && (
        <DetailRow label="Error" value={<span className="text-red-600 dark:text-red-400">{entry.errorMessage}</span>} />
      )}
      <DetailRow label="Timestamp" value={format(ts, 'yyyy-MM-dd HH:mm:ss.SSS')} />
    </div>
  )
}

export function ApiLogsView({ agentSlug }: ApiLogsViewProps) {
  useRenderTracker('ApiLogsView')
  const { selectApiLogs } = useSelection()
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { track } = useAnalyticsTracking()

  useEffect(() => {
    track('api_logs_viewed')
  }, [track])

  const { data, isLoading, refetch, isRefetching } = useQuery<{ entries: AuditLogEntry[]; total: number }>({
    queryKey: ['agent-audit-log', agentSlug, page],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/audit-log?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`)
      if (!res.ok) throw new Error('Failed to fetch audit log')
      return res.json()
    },
  })

  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-10 pt-6 pb-10 space-y-6">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => selectApiLogs(false)}
            data-testid="api-logs-back-button"
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Back
          </Button>
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-medium">API Logs</h2>
            </div>
            <div className="shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isRefetching}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefetching ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading log...
          </div>
        ) : entries.length === 0 && page === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No requests logged yet.
          </div>
        ) : (
          <>
            <Table className="text-xs [&_th]:px-3 [&_td]:px-3">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="whitespace-nowrap">Timestamp</TableHead>
                  <TableHead className="whitespace-nowrap">Duration</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="whitespace-nowrap">Policy</TableHead>
                  <TableHead>Toolkit</TableHead>
                  <TableHead className="w-full">Path (error)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => {
                  const time = format(new Date(entry.createdAt), 'MM/dd/yy, HH:mm:ss')
                  const isExpanded = expandedId === entry.id

                  return (
                    <Fragment key={entry.id}>
                      <TableRow
                        role="button"
                        tabIndex={0}
                        data-state={isExpanded ? 'selected' : undefined}
                        className={`group cursor-pointer hover:bg-muted/30 ${isExpanded ? 'bg-muted/30 border-b-0' : ''}`}
                        onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setExpandedId(isExpanded ? null : entry.id)
                          }
                        }}
                      >
                        <TableCell className="text-muted-foreground whitespace-nowrap">{time}</TableCell>
                        <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">
                          {entry.durationMs !== null ? `${entry.durationMs}ms` : '—'}
                        </TableCell>
                        <TableCell><SourceBadge source={entry.source} /></TableCell>
                        <TableCell><MethodBadge method={entry.method} /></TableCell>
                        <TableCell><StatusBadge status={entry.statusCode} /></TableCell>
                        <TableCell className="whitespace-nowrap">
                          {entry.policyDecision ? <PolicyBadge decision={entry.policyDecision} /> : null}
                        </TableCell>
                        <TableCell className="max-w-[120px]">
                          <span className="text-muted-foreground font-medium truncate block" title={entry.label}>
                            {entry.label}
                          </span>
                        </TableCell>
                        <TableCell className="min-w-0 w-full relative">
                          <p
                            className="font-mono truncate"
                            title={entry.errorMessage ? `${entry.targetUrl} (${entry.errorMessage})` : entry.targetUrl}
                          >
                            {entry.targetUrl}
                            {entry.errorMessage && (
                              <span className="text-red-600 dark:text-red-400"> ({entry.errorMessage})</span>
                            )}
                          </p>
                          <div className={`pointer-events-none absolute inset-y-0 right-2 flex items-center transition-opacity ${isExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="pointer-events-auto h-7 px-2 text-xs"
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedId(isExpanded ? null : entry.id)
                              }}
                            >
                              {isExpanded ? (
                                <>
                                  Less
                                  <ChevronUp className="h-3.5 w-3.5" />
                                </>
                              ) : (
                                <>
                                  More
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </>
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={8} className="pb-3">
                            <EntryDetails entry={entry} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-muted-foreground">
                  {total} total entries
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => setPage((p) => p - 1)}
                    disabled={page === 0}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    {page + 1} / {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= totalPages - 1}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
