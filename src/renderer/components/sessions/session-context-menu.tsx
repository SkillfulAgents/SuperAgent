
import { useState, useRef } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { Trash2, ClipboardCopy, Pencil } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'

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
  const renameInputRef = useRef<HTMLInputElement>(null)
  const deleteSession = useDeleteSession()
  const updateSessionName = useUpdateSessionName()
  const { handleSessionDeleted } = useSelection()
  const { canAdminAgent } = useUser()
  const isOwner = canAdminAgent(agentSlug)

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteSession.mutateAsync({ id: sessionId, agentSlug })
      setShowDeleteDialog(false)
      handleSessionDeleted(sessionId)
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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isOwner && (
            <ContextMenuItem onClick={() => {
              setNewName(sessionName)
              setShowRenameDialog(true)
            }}>
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
              className="text-destructive focus:text-destructive"
              onClick={() => setShowDeleteDialog(true)}
              data-testid="delete-session-item"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Session
            </ContextMenuItem>
          )}
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
