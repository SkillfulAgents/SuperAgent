import {
  StatusDialogContent,
  StatusDialogHeader,
  StatusDialogTitle,
} from '@renderer/components/agents/status-dialog'
import { Dialog } from '@renderer/components/ui/dialog'

/**
 * The blocking "Setting up your agent..." card shown while the onboarding
 * session is prepared. Undismissable by design — it closes when the provider
 * clears the pending flag.
 */
export function OnboardingSetupDialog({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <StatusDialogContent
        open={open}
        hideClose
        data-testid="onboarding-setup-dialog"
        onPointerDownOutside={(e) => e.preventDefault()}
        aria-describedby={undefined}
      >
        <StatusDialogHeader>
          <StatusDialogTitle>Setting up your agent...</StatusDialogTitle>
        </StatusDialogHeader>
      </StatusDialogContent>
    </Dialog>
  )
}
