import { useState } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
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
import { useDeleteChatIntegration } from '@renderer/hooks/use-chat-integrations'
import type { PublicChatIntegration as ChatIntegration } from '@shared/lib/chat-integrations/public'

/**
 * Header action that deletes the integration behind a confirm dialog.
 * Used in the chat integration page title actions, alongside Pause/Clear.
 */
export function IntegrationDeleteButton({ integration, onDeleted }: {
  integration: ChatIntegration
  onDeleted: () => void
}) {
  const deleteIntegration = useDeleteChatIntegration()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label="Delete integration"
        title="Delete integration"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={deleteIntegration.isPending}
        onClick={() => setOpen(true)}
      >
        {deleteIntegration.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Chat Integration</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect the bot and remove this integration permanently.
              Existing conversation history will be preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await deleteIntegration.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug })
                onDeleted()
              }}
              disabled={deleteIntegration.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteIntegration.isPending ? 'Deleting...' : 'Delete Integration'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
