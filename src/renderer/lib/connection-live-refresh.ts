import { toast } from 'sonner'

export function warnIfLiveRefreshFailed(result: unknown): void {
  if (
    typeof result === 'object' &&
    result !== null &&
    'liveRefresh' in result &&
    result.liveRefresh === false
  ) {
    toast.warning(
      'One or more running agents need a restart to apply the latest connection state.',
    )
  } else if (
    typeof result === 'object' && result !== null &&
    'sessionNotification' in result && result.sessionNotification === false
  ) {
    toast.warning('The connection was replaced, but a session could not be notified. Send it a message to continue with the new connection.')
  }
}
