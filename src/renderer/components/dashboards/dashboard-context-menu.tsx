
import { useState } from 'react'
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
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Pencil, Trash2 } from 'lucide-react'

interface DashboardContextMenuProps {
  artifactSlug: string
  artifactName: string
  agentSlug: string
  onRenameRequest?: () => void
  children: React.ReactNode
}

export function DashboardContextMenu({
  artifactSlug,
  artifactName,
  agentSlug,
  onRenameRequest,
  children,
}: DashboardContextMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const { handleDashboardDeleted } = useSelection()
  const { canAdminAgent } = useUser()
  const queryClient = useQueryClient()
  const isOwner = canAdminAgent(agentSlug)

  // No menu items for non-owners, skip the context menu entirely
  if (!isOwner) {
    return <>{children}</>
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const res = await apiFetch(`/api/agents/${agentSlug}/artifacts/${artifactSlug}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        throw new Error('Failed to delete dashboard')
      }
      setShowDeleteDialog(false)
      handleDashboardDeleted(artifactSlug)
      queryClient.invalidateQueries({ queryKey: ['artifacts', agentSlug] })
    } catch (error) {
      console.error('Failed to delete dashboard:', error)
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
          {onRenameRequest && (
            <>
              <ContextMenuItem onClick={onRenameRequest}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename Dashboard
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Dashboard
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Dashboard</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{artifactName}&quot;? This will permanently
              remove the dashboard and all its files. This action cannot be undone.
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
    </>
  )
}
