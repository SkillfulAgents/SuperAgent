import { useSyncExternalStore } from 'react'
import { volumeStopConfirmation } from '@renderer/lib/volume-stop'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'

export function VolumeStopDialog() {
  const request = useSyncExternalStore(volumeStopConfirmation.subscribe, volumeStopConfirmation.getSnapshot)
  return (
    <AlertDialog open={!!request} onOpenChange={open => { if (!open) volumeStopConfirmation.answer(false) }}>
      <AlertDialogContent data-testid="volume-stop-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Some files may not be synced</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>{request?.message}</p>
              <p>Stopping now may permanently lose files that haven’t finished uploading. You can cancel, restore the connection, and try again.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={event => {
              // Resolve exactly this request; Radix's automatic close must not
              // also cancel the next queued confirmation.
              event.preventDefault()
              volumeStopConfirmation.answer(true)
            }}
          >
            {request?.action} anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
