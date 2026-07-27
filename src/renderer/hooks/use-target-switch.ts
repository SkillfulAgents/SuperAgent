import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

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

  // Only ask about cloud availability from the LOCAL side. In cloud mode every
  // request goes through the proxy to the deployment, and `getCloudWorkspace`
  // self-gates off the Electron main process — so the deployment would answer
  // "no cloud workspace" about itself, and the control would hide exactly when
  // the user needs it to get back. Being in cloud mode is its own proof.
  const canAsk = isElectron() && current === 'local' && platform?.connected === true
  const { data: workspace } = useCloudWorkspace(canAsk, platform?.orgId)

  const cloudReachable =
    current === 'cloud' || (workspace?.found === true && workspace.hasValidToken === true)

  const switchTo = useCallback(
    async (target: ApiTarget) => {
      if (target === current || switching) return
      setSwitching(true)
      // The reload drops this in-memory cache anyway; clearing first keeps the
      // previous Superagent's data off screen during the await.
      queryClient.clear()
      await switchTarget(target)
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
