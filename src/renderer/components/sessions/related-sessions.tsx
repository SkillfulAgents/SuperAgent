import { useMemo, useRef, useState } from 'react'
import { MessageSquare, ChevronLeft, ChevronRight, MoreVertical, Pencil, ClipboardCopy, Trash2 } from 'lucide-react'
import { WorkingDots, AwaitingDot } from '@renderer/components/agents/status-indicators'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { useDeleteSession, useUpdateSessionName } from '@renderer/hooks/use-sessions'
import { apiFetch } from '@renderer/lib/api'

interface SessionItem {
  id: string
  name: string
  createdAt: string
  isActive?: boolean
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
}

interface RelatedSessionsProps {
  sessions: SessionItem[]
  formatDate: (date: string) => string
  className?: string
  showIcon?: boolean
  title?: string
  showHeader?: boolean
  agentSlug?: string
  searchQuery?: string
  sortOrder?: SortOrder
  dateAsTitle?: boolean
  formatSubtext?: (date: string) => string
  pageSize?: number
}

export type SortOrder = 'newest' | 'oldest'

const DEFAULT_PAGE_SIZE = 10

export function RelatedSessions({ sessions, formatDate, className, showIcon = true, title, showHeader = true, agentSlug, searchQuery, sortOrder: sortOrderProp, dateAsTitle = false, formatSubtext, pageSize = DEFAULT_PAGE_SIZE }: RelatedSessionsProps) {
  const [page, setPage] = useState(0)
  const [sortOrderInternal, setSortOrder] = useState<SortOrder>('newest')
  const sortOrder = sortOrderProp ?? sortOrderInternal

  const filtered = useMemo(() => {
    if (!searchQuery?.trim()) return sessions
    const q = searchQuery.toLowerCase()
    return sessions.filter((s) => s.name.toLowerCase().includes(q))
  }, [sessions, searchQuery])

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => {
      const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      return sortOrder === 'newest' ? diff : -diff
    })
    return copy
  }, [filtered, sortOrder])

  // Reset page when search query changes
  const prevQuery = useRef(searchQuery)
  if (prevQuery.current !== searchQuery) {
    prevQuery.current = searchQuery
    if (page !== 0) setPage(0)
  }

  const totalPages = Math.ceil(sorted.length / pageSize)
  const paginated = sorted.slice(page * pageSize, (page + 1) * pageSize)

  if (sessions.length === 0) return null

  return (
    <div className={className}>
      {showHeader && (
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {title ?? 'Related Sessions'}
          </h3>
          <Select value={sortOrder} onValueChange={(v) => { setSortOrder(v as SortOrder); setPage(0) }}>
            <SelectTrigger className="h-7 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="divide-y divide-border/50">
        {paginated.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            showIcon={showIcon}
            formatDate={formatDate}
            agentSlug={agentSlug}
            searchQuery={searchQuery}
            dateAsTitle={dateAsTitle}
            formatSubtext={formatSubtext}
          />
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SessionRow({ session, showIcon, formatDate, agentSlug: agentSlugProp, searchQuery, dateAsTitle = false, formatSubtext }: { session: SessionItem; showIcon: boolean; formatDate: (date: string) => string; agentSlug?: string; searchQuery?: string; dateAsTitle?: boolean; formatSubtext?: (date: string) => string }) {
  const { selectSession, selectedAgentSlug, handleSessionDeleted } = useSelection()
  const agentSlug = agentSlugProp ?? selectedAgentSlug
  const { canAdminAgent } = useUser()
  const isOwner = agentSlug ? canAdminAgent(agentSlug) : false
  const deleteSession = useDeleteSession()
  const updateSessionName = useUpdateSessionName()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [newName, setNewName] = useState(session.name)

  const handleDelete = async () => {
    if (!agentSlug) return
    setIsDeleting(true)
    try {
      await deleteSession.mutateAsync({ id: session.id, agentSlug })
      setShowDeleteDialog(false)
      handleSessionDeleted(session.id)
    } catch (error) {
      console.error('Failed to delete session:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleRename = async () => {
    if (!agentSlug) return
    const trimmed = newName.trim()
    if (!trimmed || trimmed === session.name) {
      setShowRenameDialog(false)
      return
    }
    try {
      await updateSessionName.mutateAsync({ sessionId: session.id, agentSlug, name: trimmed })
      setShowRenameDialog(false)
    } catch (error) {
      console.error('Failed to rename session:', error)
    }
  }

  const handleCopyRawLog = async () => {
    if (!agentSlug) return
    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${session.id}/raw-log`)
      if (!response.ok) throw new Error('Failed to fetch raw log')
      const text = await response.text()
      await navigator.clipboard.writeText(text)
    } catch (error) {
      console.error('Failed to copy raw log:', error)
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="group relative w-full flex items-center gap-3 py-3 px-1 hover:bg-muted/50 transition-colors text-left cursor-pointer"
        onClick={() => selectSession(session.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            selectSession(session.id)
          }
        }}
      >
        {showIcon && <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className={`text-xs truncate flex items-center gap-2 ${dateAsTitle ? 'font-normal' : 'font-medium'}`}>
            {session.isAwaitingInput ? (
              <AwaitingDot />
            ) : session.isActive ? (
              <WorkingDots />
            ) : session.hasUnreadNotifications ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
            ) : null}
            {dateAsTitle ? (
              <>
                <span>{formatDate(session.createdAt)}</span>
                {formatSubtext && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {formatSubtext(session.createdAt)}
                  </span>
                )}
              </>
            ) : (
              <HighlightMatch text={session.name} query={searchQuery ?? ''} />
            )}
          </div>
          {!dateAsTitle && (
            <div className="text-xs text-muted-foreground truncate">
              {formatDate(session.createdAt)}
            </div>
          )}
        </div>
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label={`Actions for ${session.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              {isOwner && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setNewName(session.name)
                    setShowRenameDialog(true)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename Session
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  handleCopyRawLog()
                }}
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
                Copy Raw Log
              </button>
              {isOwner && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowDeleteDialog(true)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete Session
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Session</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{session.name}&quot;? This will permanently
              delete the session and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="overflow-hidden">
          <DialogHeader>
            <DialogTitle>Rename Session</DialogTitle>
            <DialogDescription>
              Enter a new name for this session.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); handleRename() }}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Session name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setShowRenameDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateSessionName.isPending || !newName.trim()}>
                {updateSessionName.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
