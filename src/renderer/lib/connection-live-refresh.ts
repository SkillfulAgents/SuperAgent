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
  }
}
