import { useState } from 'react'
import { CircleCheck, Loader2 } from 'lucide-react'

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
import { Button } from '@renderer/components/ui/button'
import { RequestError } from '@shared/lib/tools/requests/request-error'
import { useAccountDeletionStatus, useRequestAccountDeletion } from '@renderer/hooks/use-account-deletion'

// Shared with the Account tab's other sections.
const CARD_CLASS = 'rounded-card border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

interface AccountDeletionSectionProps {
  /** The connected Gamut account's id: the account the request names. */
  userId: string
  email: string | null
}

/**
 * "Request account deletion" for the connected Gamut account. The request goes
 * to support, who delete the account within 14 days; nothing is deleted here.
 * Same flow and wording as the iOS app's Profile screen.
 */
export function AccountDeletionSection({ userId, email }: AccountDeletionSectionProps) {
  const { data: status } = useAccountDeletionStatus(true)
  const request = useRequestAccountDeletion()
  const [confirming, setConfirming] = useState(false)

  if (!status?.available) return null

  const sent = status.request?.accepted === true

  return (
    <div className="space-y-2" data-testid="account-deletion-section">
      <h3 className={SECTION_HEADING}>Account deletion</h3>
      <div className={CARD_CLASS}>
        <div className="py-3 px-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">
                {sent ? 'Deletion request sent' : 'Request account deletion'}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {sent
                  ? 'Support will delete your Gamut account and associated personal data within 14 days and email you when complete.'
                  : 'Request deletion of your Gamut account and associated personal data. Support will process it within 14 days and email you when complete. Your account is not deleted immediately.'}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {sent ? (
                <CircleCheck className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden data-testid="account-deletion-sent" />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={request.isPending}
                  onClick={() => setConfirming(true)}
                  data-testid="account-deletion-request"
                >
                  {request.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      Sending request…
                    </>
                  ) : (
                    'Request deletion'
                  )}
                </Button>
              )}
            </div>
          </div>
          {request.isError && !sent && (
            <div className="mt-2" data-testid="account-deletion-error">
              <RequestError message={request.error.message} variant="compact" />
            </div>
          )}
        </div>
        {status.request && (
          <div className="py-3 px-4 flex items-center gap-3">
            <div className="min-w-0 flex-1 text-xs font-medium">Request ID</div>
            <span className="text-xs text-muted-foreground font-mono select-text" data-testid="account-deletion-request-id">
              {status.request.requestId}
            </span>
          </div>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Request account deletion?</AlertDialogTitle>
            <AlertDialogDescription>
              This requests deletion for {email ?? 'your Gamut account'}. Your account ID will be sent through
              Amplitude to process this request, even if usage analytics is off. Support will complete deletion
              within 14 days and email you confirmation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => request.mutate(userId)}
              data-testid="account-deletion-confirm"
            >
              Send deletion request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
