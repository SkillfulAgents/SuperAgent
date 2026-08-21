
import { useState, useRef } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
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
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useDeleteSession, useUpdateSessionName } from '@renderer/hooks/use-sessions'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { Trash2, ClipboardCopy, Pencil } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import type { SessionUsageTotals } from '@shared/lib/types/usage'

type UsageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; totals: SessionUsageTotals }
  | { status: 'error' }

function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return '<$0.0001'
  const digits = cost > 0 && cost < 0.01 ? 4 : 2
  return `$${cost.toFixed(digits)}`
}

interface SessionContextMenuProps {
  sessionId: string
  sessionName: string
  agentSlug: string
  children: React.ReactNode
}

export function SessionContextMenu({
  sessionId,
  sessionName,
  agentSlug,
  children,
}: SessionContextMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [newName, setNewName] = useState(sessionName)
  const [usage, setUsage] = useState<UsageState>({ status: 'idle' })
  const renameInputRef = useRef<HTMLInputElement>(null)
  const usageRequestRef = useRef(0)
  const deleteSession = useDeleteSession()
  const updateSessionName = useUpdateSessionName()
  const navigate = useNavigate()
  // strict:false → undefined when the menu is opened off the session route
  // (e.g. from the sidebar list), so the up-nav only fires when we're actually
  // viewing the session being deleted.
  const params = useParams({ strict: false }) as { sessionId?: string }
  const { canAdminAgent } = useUser()
  const isOwner = canAdminAgent(agentSlug)

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteSession.mutateAsync({ id: sessionId, agentSlug })
      setShowDeleteDialog(false)
      if (params.sessionId === sessionId) {
        void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
      }
    } catch (error) {
      console.error('Failed to delete session:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleRename = async () => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === sessionName) {
      setShowRenameDialog(false)
      return
    }
    try {
      await updateSessionName.mutateAsync({ sessionId, agentSlug, name: trimmed })
      setShowRenameDialog(false)
    } catch (error) {
      console.error('Failed to rename session:', error)
    }
  }

  const handleCopyRawLog = async () => {
    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/raw-log`)
      if (!response.ok) {
        throw new Error('Failed to fetch raw log')
      }
      const text = await response.text()
      await navigator.clipboard.writeText(text)
    } catch (error) {
      console.error('Failed to copy raw log:', error)
    }
  }

  const handleMenuOpenChange = (open: boolean) => {
    if (!open) return

    const requestId = ++usageRequestRef.current
    setUsage({ status: 'loading' })

    void apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/usage`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to fetch session usage')
        const totals = (await response.json()) as SessionUsageTotals
        if (usageRequestRef.current === requestId) {
          setUsage({ status: 'success', totals })
        }
      })
      .catch((error) => {
        if (usageRequestRef.current === requestId) {
          console.error('Failed to fetch session usage:', error)
          setUsage({ status: 'error' })
        }
      })
  }

  return (
    <>
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <ContextMenuTrigger asChild>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isOwner && (
            <ContextMenuItem
              data-testid="rename-session-item"
              onClick={() => {
                setNewName(sessionName)
                setShowRenameDialog(true)
              }}
            >
              <Pencil className="h-4 w-4 mr-2" />
              Rename Session
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={handleCopyRawLog}>
            <ClipboardCopy className="h-4 w-4 mr-2" />
            Copy Raw Log
          </ContextMenuItem>
          {isOwner && (
            <ContextMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onClick={() => setShowDeleteDialog(true)}
              data-testid="delete-session-item"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Session
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <div
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2 py-1.5 text-xs"
            data-testid="session-usage-totals"
          >
            {usage.status === 'loading' || usage.status === 'idle' ? (
              <span className="col-span-2 text-muted-foreground">Calculating usage...</span>
            ) : usage.status === 'error' ? (
              <span className="col-span-2 text-muted-foreground">Usage unavailable</span>
            ) : (
              <>
                <span className="text-muted-foreground">Cost</span>
                <span className="text-right tabular-nums">
                  {usage.totals.priceMissing
                    ? 'Model price missing'
                    : formatCost(usage.totals.totalCost)}
                </span>
                <span className="text-muted-foreground">Tokens</span>
                <span className="text-right tabular-nums">
                  {usage.totals.totalTokens.toLocaleString('en-US')}
                </span>
                {usage.totals.usageIncomplete && (
                  <span className="col-span-2 text-amber-600 dark:text-amber-400">
                    Warning: usage may be incomplete
                  </span>
                )}
              </>
            )}
          </div>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent data-testid="confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Session</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{sessionName}&quot;? This will permanently
              delete the session and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="confirm-button"
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
              ref={renameInputRef}
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
