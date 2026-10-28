import { useState, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@renderer/components/ui/table'
import { useAuditLog, useAuditLogFilters } from '@renderer/hooks/use-audit-log'
import { useUser } from '@renderer/context/user-context'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react'

const PAGE_SIZE = 25

const ALL_FILTER = '__all__'

function formatTimestamp(date: Date | string | number): string {
  const d = new Date(date)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDetailValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    if ('from' in obj && 'to' in obj) return `${obj.from ?? '(unset)'} → ${obj.to ?? '(unset)'}`
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${formatDetailValue(v)}`)
      .join(', ')
  }
  return String(value)
}

function formatDetails(details: string | null): string {
  if (!details) return ''
  try {
    return formatDetailValue(JSON.parse(details))
  } catch {
    return details
  }
}

export function AuditLogTab() {
  const { isAuthMode } = useUser()
  const [page, setPage] = useState(0)
  const [objectFilter, setObjectFilter] = useState<string>(ALL_FILTER)
  const [actionFilter, setActionFilter] = useState<string>(ALL_FILTER)
  const [userFilter, setUserFilter] = useState<string>(ALL_FILTER)

  const { data: filters } = useAuditLogFilters()
  const eventMap = filters?.eventMap
  const users = filters?.users ?? []
  const userMap = new Map(users.map(u => [u.id, u]))

  const objects = eventMap ? Object.keys(eventMap) : []
  const actions = eventMap
    ? objectFilter !== ALL_FILTER
      ? [...(eventMap[objectFilter] ?? [])]
      : [...new Set(Object.values(eventMap).flat())]
    : []

  // Reset action filter when object changes and the current action isn't valid
  useEffect(() => {
    if (actionFilter !== ALL_FILTER && !actions.includes(actionFilter)) {
      setActionFilter(ALL_FILTER)
    }
  }, [objectFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useAuditLog({
    object: objectFilter !== ALL_FILTER ? objectFilter : undefined,
    action: actionFilter !== ALL_FILTER ? actionFilter : undefined,
    userId: userFilter !== ALL_FILTER ? userFilter : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  })

  useEffect(() => { setPage(0) }, [objectFilter, actionFilter, userFilter])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const entries = data?.entries ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Audit Log</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Select value={objectFilter} onValueChange={setObjectFilter}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue placeholder="All objects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER}>All objects</SelectItem>
            {objects.map((obj) => (
              <SelectItem key={obj} value={obj}>{obj}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER}>All actions</SelectItem>
            {actions.map((action) => (
              <SelectItem key={action} value={action}>{action}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isAuthMode && (
          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FILTER}>All users</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name || u.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading audit log...
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No audit events found.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">Time</TableHead>
              {isAuthMode && <TableHead className="w-[120px]">User</TableHead>}
              <TableHead className="w-[100px]">Object</TableHead>
              <TableHead className="w-[100px]">Action</TableHead>
              <TableHead className="w-[180px]">Object ID</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatTimestamp(entry.createdAt)}
                </TableCell>
                {isAuthMode && (
                  <TableCell className="text-xs truncate max-w-[120px]">
                    {entry.userId ? (() => {
                      const u = userMap.get(entry.userId!)
                      return u ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">{u.name}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="text-xs">{u.email}</div>
                            <div className="text-2xs text-muted-foreground font-mono">{u.id}</div>
                          </TooltipContent>
                        </Tooltip>
                      ) : entry.userId
                    })() : '-'}
                  </TableCell>
                )}
                <TableCell>
                  <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">
                    {entry.object}
                  </span>
                </TableCell>
                <TableCell className="text-xs">{entry.action}</TableCell>
                <TableCell className="text-xs text-muted-foreground truncate max-w-[180px] font-mono">
                  {entry.objectId}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground truncate max-w-[240px]" title={formatDetails(entry.details)}>
                  {formatDetails(entry.details)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Pagination */}
      {data && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {data.total} event{data.total !== 1 ? 's' : ''} total
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
