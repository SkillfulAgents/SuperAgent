import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { switchTarget, targetIsRemote, type ApiTarget } from '@renderer/lib/api-target'
import { isElectron } from '@renderer/lib/env'
import { useCloudWorkspace } from '@renderer/hooks/use-cloud-workspace'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'

/**
 * State for the Local/Cloud control: which Superagent this window is driving,
 * whether the other one is reachable, and how to move.
 */
export function useTargetSwitch() {
  const current: ApiTarget = targetIsRemote() ? 'cloud' : 'local'
  const [switching, setSwitching] = useState(false)
  const queryClient = useQueryClient()

  const { data: platform } = usePlatformAuthStatus()

  // IPC-backed discovery works in both targets. Cloud mode is also its own
  // proof the workspace exists (we already switched there).
  const canAsk =
    isElectron() && (current === 'cloud' || platform?.connected === true)
  const { data: workspace } = useCloudWorkspace(canAsk, platform?.orgId)

  const cloudReachable =
    current === 'cloud' || (workspace?.found === true && workspace.hasValidToken === true)

  const switchTo = useCallback(
    async (target: ApiTarget) => {
      if (target === current || switching) return
      setSwitching(true)
      try {
        await switchTarget(target)
      } catch (error) {
        // The preference write goes over IPC and can fail (settings unwritable,
        // main gone). Nothing changed when it does — this window is still
        // driving `current` — so the control has to come back rather than sit
        // disabled over a UI that only a manual reload can repair. This is also
        // why the cache is not dropped until the write has succeeded.
        setSwitching(false)
        toast.error('Could not switch workspace', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
        return
      }
      // The reload has been requested but has not committed yet; clearing keeps
      // the previous Superagent's data off screen for that moment. `switching`
      // deliberately stays true — this window is on its way out.
      queryClient.clear()
    },
    [current, switching, queryClient],
  )

  return {
    current,
    switching,
    /** Whether to offer the control at all. */
    available: isElectron() && cloudReachable,
    switchTo,
  }
}
