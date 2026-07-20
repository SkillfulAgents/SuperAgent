import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { format } from 'date-fns'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@renderer/components/ui/table'
import type { RequestLogEntry } from '@shared/lib/types/request-log'

export const REQUEST_LOG_PAGE_SIZE = 15

export interface RequestLogColumns {
  source?: boolean
  toolkit?: boolean
  agent?: boolean
}

interface RequestLogsTableProps {
  entries: RequestLogEntry[]
  total: number
  page: number
  onPageChange: (page: number) => void
  isLoading: boolean
  columns: RequestLogColumns
  agentLabel?: (agentSlug: string) => ReactNode
  emptyMessage?: string
}

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
  if (status === null) return <span className="text-xs text-muted-foreground">—</span>
  const color = status >= 200 && status < 300
    ? 'text-green-700 dark:text-green-400'
    : status >= 400
      ? 'text-red-700 dark:text-red-400'
      : 'text-muted-foreground'
  return <span className={`text-xs font-mono font-medium ${color}`}>{status}</span>
}

function SourceBadge({ source }: { source: RequestLogEntry['source'] }) {
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

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-24">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  )
}

function EntryDetails({
  entry,
  columns,
  agentLabel,
}: {
  entry: RequestLogEntry
  columns: RequestLogColumns
  agentLabel?: (agentSlug: string) => ReactNode
}) {
  const scopes: string[] = entry.matchedScopes ? (() => {
    try {
      const parsed: unknown = JSON.parse(entry.matchedScopes)
      return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : []
    } catch { return [] }
  })() : []
  const ts = new Date(entry.createdAt)

  return (
    <div className="text-xs space-y-1.5 pt-1">
      <DetailRow label="Full path" value={<span className="font-mono">{entry.targetUrl}</span>} />
      {columns.agent && <DetailRow label="Agent" value={agentLabel?.(entry.agentSlug) ?? entry.agentSlug} />}
      {columns.source && <DetailRow label="Source" value={entry.source === 'mcp' ? 'MCP Proxy' : 'API Proxy'} />}
      {columns.toolkit && <DetailRow label="Toolkit / MCP" value={entry.label} />}
      <DetailRow label="Method" value={entry.method} />
      <DetailRow label="Status" value={entry.statusCode ?? '—'} />
      {entry.policyDecision && <DetailRow label="Policy" value={<PolicyBadge decision={entry.policyDecision} />} />}
      {scopes.length > 0 && (
        <DetailRow
          label="Scopes"
          value={
            <div className="flex flex-wrap gap-1">
              {scopes.map((scope) => (
                <span key={scope} className="font-mono bg-muted rounded px-1 py-0.5">{scope}</span>
              ))}
            </div>
          }
        />
      )}
      {entry.durationMs !== null && <DetailRow label="Duration" value={`${entry.durationMs}ms`} />}
      {entry.errorMessage && (
        <DetailRow label="Error" value={<span className="text-red-600 dark:text-red-400">{entry.errorMessage}</span>} />
      )}
      <DetailRow label="Timestamp" value={format(ts, 'yyyy-MM-dd HH:mm:ss.SSS')} />
    </div>
  )
}

export function RequestLogsTable({
  entries,
  total,
  page,
  onPageChange,
  isLoading,
  columns,
  agentLabel,
  emptyMessage = 'No requests logged yet.',
}: RequestLogsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const totalPages = Math.ceil(total / REQUEST_LOG_PAGE_SIZE)
  const columnCount = 7 + Number(!!columns.source) + Number(!!columns.toolkit) + Number(!!columns.agent)

  useEffect(() => setExpandedId(null), [page])

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading log...
      </div>
    )
  }

  if (entries.length === 0 && page === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <>
      <Table className="min-w-[820px] text-xs [&_th]:px-3 [&_td]:px-3">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="whitespace-nowrap">Timestamp</TableHead>
            <TableHead className="whitespace-nowrap">Duration</TableHead>
            {columns.source && <TableHead>Source</TableHead>}
            {columns.agent && <TableHead>Agent</TableHead>}
            <TableHead>Method</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="whitespace-nowrap">Policy</TableHead>
            {columns.toolkit && <TableHead>Toolkit</TableHead>}
            <TableHead className="w-full min-w-[240px]">Path (error)</TableHead>
            <TableHead className="w-[88px]" aria-label="Toggle details" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const time = format(new Date(entry.createdAt), 'MM/dd/yy, HH:mm:ss')
            const isExpanded = expandedId === entry.id
            return (
              <Fragment key={`${entry.source}-${entry.id}`}>
                <TableRow
                  role="button"
                  tabIndex={0}
                  data-state={isExpanded ? 'selected' : undefined}
                  className={`group cursor-pointer hover:bg-muted/30 ${isExpanded ? 'bg-muted/30 border-b-0' : ''}`}
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setExpandedId(isExpanded ? null : entry.id)
                    }
                  }}
                >
                  <TableCell className="text-muted-foreground whitespace-nowrap">{time}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">
                    {entry.durationMs !== null ? `${entry.durationMs}ms` : '—'}
                  </TableCell>
                  {columns.source && <TableCell><SourceBadge source={entry.source} /></TableCell>}
                  {columns.agent && (
                    <TableCell className="max-w-[160px]">
                      <span className="font-medium truncate block" title={entry.agentSlug}>
                        {agentLabel?.(entry.agentSlug) ?? entry.agentSlug}
                      </span>
                    </TableCell>
                  )}
                  <TableCell><MethodBadge method={entry.method} /></TableCell>
                  <TableCell><StatusBadge status={entry.statusCode} /></TableCell>
                  <TableCell className="whitespace-nowrap">
                    {entry.policyDecision ? <PolicyBadge decision={entry.policyDecision} /> : null}
                  </TableCell>
                  {columns.toolkit && (
                    <TableCell className="max-w-[120px]">
                      <span className="text-muted-foreground font-medium truncate block" title={entry.label}>
                        {entry.label}
                      </span>
                    </TableCell>
                  )}
                  <TableCell className="min-w-0 w-full">
                    <p
                      className="font-mono truncate"
                      title={entry.errorMessage ? `${entry.targetUrl} (${entry.errorMessage})` : entry.targetUrl}
                    >
                      {entry.targetUrl}
                      {entry.errorMessage && (
                        <span className="text-red-600 dark:text-red-400"> ({entry.errorMessage})</span>
                      )}
                    </p>
                  </TableCell>
                  <TableCell className="w-[88px] text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={`h-7 px-2 text-xs transition-opacity ${isExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpandedId(isExpanded ? null : entry.id)
                      }}
                    >
                      {isExpanded ? <><span>Less</span><ChevronUp className="h-3.5 w-3.5" /></> : <><span>More</span><ChevronDown className="h-3.5 w-3.5" /></>}
                    </Button>
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={columnCount} className="pb-3">
                      <EntryDetails entry={entry} columns={columns} agentLabel={agentLabel} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between pt-2">
        <span className="text-xs text-muted-foreground">{total} total entries</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="Previous page"
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">{page + 1} / {totalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="Next page"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
