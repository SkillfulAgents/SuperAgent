import { useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { SlideToConfirm } from '@renderer/components/ui/slide-to-confirm'
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
 * The one delete-agent confirmation, opened from the agent context menu
 * (every agent entry point shares that menu). Owns the mutation, the
 * navigate-away-when-viewing-the-agent behavior, and the copy.
 *
 * Deleting an agent takes its sessions and data with it, so the confirm is
 * a slide rather than a button: a handle has to be pushed the length of its
 * track, which a stray click cannot do. The handle unfurls into "Deleting…"
 * while the mutation runs and the dialog closes behind it; a failed delete
 * toasts and slides the handle back so it can be tried again.
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
      // Rethrown so the slider knows to re-arm; the toast above is the report.
      throw error
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* max-w-sm: wide enough for the 280px slider and one line of copy, no wider */}
      <AlertDialogContent className="max-w-sm" data-testid="confirm-delete-agent-dialog">
        <AlertDialogClose disabled={isDeleting} data-testid="cancel-delete-agent-button" />
        <AlertDialogHeader className="sm:text-center">
          {/* symmetric padding keeps the centred title clear of the X without skewing it */}
          <AlertDialogTitle className="break-words px-8">Delete {agentName}?</AlertDialogTitle>
          <AlertDialogDescription>All data will be deleted permanently.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-2 sm:justify-center">
          <SlideToConfirm
            className="self-center"
            tone="destructive"
            label="Slide to delete"
            confirmedLabel={isDeleting ? 'Deleting…' : 'Deleted'}
            onConfirm={handleDelete}
            data-testid="confirm-delete-agent-button"
          />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
