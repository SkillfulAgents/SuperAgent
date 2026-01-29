import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { formatDistanceToNow } from 'date-fns'

interface AuditLogEntry {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  targetHost: string
  targetPath: string
  method: string
  statusCode: number | null
  errorMessage: string | null
  createdAt: string
}

interface AuditLogTabProps {
  agentSlug: string
}

const PAGE_SIZE = 20

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/40',
    POST: 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/40',
    PUT: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40',
    PATCH: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40',
    DELETE: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/40',
  }
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${colors[method] ?? 'text-muted-foreground bg-muted'}`}>
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

export function AuditLogTab({ agentSlug }: AuditLogTabProps) {
  const [page, setPage] = useState(0)

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">API Request Log</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Recent API calls made through the proxy by this agent.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading log...
        </div>
      ) : entries.length === 0 && page === 0 ? (
        <p className="text-sm text-muted-foreground">
          No API requests logged yet.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {entries.map((entry) => {
              const fullUrl = `${entry.targetHost}/${entry.targetPath}`
              const time = formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })

              return (
                <div
                  key={entry.id}
                  className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                >
                  <MethodBadge method={entry.method} />
                  <StatusBadge status={entry.statusCode} />
                  <div className="min-w-0">
                    <p
                      className="font-mono text-xs truncate"
                      title={fullUrl}
                    >
                      {fullUrl}
                    </p>
                    {entry.errorMessage && (
                      <p className="text-red-600 dark:text-red-400 mt-0.5 truncate" title={entry.errorMessage}>
                        {entry.errorMessage}
                      </p>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 whitespace-nowrap">
                    {time}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Pagination */}
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
  )
}
