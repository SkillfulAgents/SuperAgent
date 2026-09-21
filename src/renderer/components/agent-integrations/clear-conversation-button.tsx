import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
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

interface ClearConversationButtonProps {
  providerName: string
  /** Chat display name, named in the confirm dialog so the target is explicit. */
  chatTitle?: string
  /** True while the clear mutation is in-flight. */
  pending?: boolean
  /** Called after the user confirms clearing the current conversation. */
  onConfirm: () => void
}

/**
 * Page-header action that starts a fresh conversation for the chat currently
 * open - it archives the current one (history preserved, still reachable in
 * the window switcher) so the next message begins anew. The manual
 * counterpart to "Start new conversation after inactivity". Sized to sit
 * flush with IntegrationDeleteButton in the title bar.
 */
export function ClearConversationButton({ providerName, chatTitle, pending, onConfirm }: ClearConversationButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-9 gap-1.5 px-3 text-xs"
        aria-label="New conversation"
        title="New conversation"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        New conversation
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {chatTitle
                ? `This archives the conversation with ${chatTitle} and starts fresh on the next message. History is preserved.`
                : `This archives the current conversation and starts fresh on the next message from ${providerName}. History is preserved.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'New conversation'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
