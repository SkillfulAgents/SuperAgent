import { statusDialogAnimation, StatusDialogMatrix } from '@renderer/components/agents/status-dialog-style'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

/**
 * The blocking "Setting up your agent..." card shown while the onboarding
 * session is prepared. Undismissable by design — it closes when the provider
 * clears the pending flag.
 */
export function OnboardingSetupDialog({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-lg min-h-72 content-center [&>button]:hidden"
        style={statusDialogAnimation.contentStyle}
        overlayClassName={statusDialogAnimation.overlay}
        overlayStyle={statusDialogAnimation.overlayStyle}
        data-testid="onboarding-setup-dialog"
        onPointerDownOutside={(e) => e.preventDefault()}
        aria-describedby={undefined}
      >
        <StatusDialogMatrix />
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle className="status-title-shimmer text-base font-normal">Setting up your agent...</DialogTitle>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
