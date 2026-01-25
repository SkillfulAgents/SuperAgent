
import { useState } from 'react'
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
import { useDeleteSession } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { Trash2 } from 'lucide-react'

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
  const [isDeleting, setIsDeleting] = useState(false)
  const deleteSession = useDeleteSession()
  const { handleSessionDeleted } = useSelection()

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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            data-testid="delete-session-item"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Session
          </ContextMenuItem>
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
    </>
  )
}
