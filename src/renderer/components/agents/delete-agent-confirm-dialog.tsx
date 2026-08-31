import { useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
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
import { useDeleteAgent, useRouteAgentId } from '@renderer/hooks/use-agents'

interface DeleteAgentConfirmDialogProps {
  agentSlug: string
  agentName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs after a successful delete (e.g. close the parent settings dialog). */
  onDeleted?: () => void
}

/**
 * The one delete-agent confirmation, shared by the header settings popover,
 * the sidebar context menu, and the settings dialog's Danger Zone. Owns the
 * mutation, the navigate-away-when-viewing-the-agent behavior, and the copy.
 */
export function DeleteAgentConfirmDialog({
  agentSlug,
  agentName,
  open,
  onOpenChange,
  onDeleted,
}: DeleteAgentConfirmDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const deleteAgent = useDeleteAgent()
  const navigate = useNavigate()
  const routeAgentId = useRouteAgentId()

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteAgent.mutateAsync(agentSlug)
      onOpenChange(false)
      onDeleted?.()
      if (routeAgentId === agentSlug) void navigate({ to: '/' })
    } catch (error) {
      console.error('Failed to delete agent:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete agent')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="confirm-delete-agent-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Agent</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete &quot;{agentName}&quot;? This will permanently delete
            the agent and all its sessions, messages, and data. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="confirm-delete-agent-button"
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
