import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { switchTarget, targetIsRemote, type ApiTarget } from '@renderer/lib/api-target'
import { isElectron } from '@renderer/lib/env'
import { openExternalUrl } from '@renderer/lib/open-external'
import { useDialogs } from '@renderer/context/dialog-context'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useCloudWorkspace, type CloudWorkspaceResponse } from '@renderer/hooks/use-cloud-workspace'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'

type Banner = { title: string; text: string }

const SETTING_UP: Banner = {
  title: 'Your cloud workspace is setting up',
  text: 'This takes about a minute. Press Cloud again when it’s ready.',
}

// What Cloud says when the org's workspace exists but isn't running, by
// platform's status. A status missing here opens platform's page, which knows it.
const STATUS_BANNERS: Record<string, Banner> = {
  pending: SETTING_UP,
  deploying: SETTING_UP,
  destroying: {
    title: 'Your cloud workspace is going to sleep',
    text: 'You can wake it on platform once it’s asleep.',
  },
  destroyed: {
    title: 'Your cloud workspace is asleep',
    text: 'Wake it on platform. It takes about a minute, then press Cloud again.',
  },
  error: {
    // Platform writes `error` when starting or stopping fails.
    title: 'Your cloud workspace ran into a problem',
    text: 'See what went wrong on platform.',
  },
}

/** The banner for a check that found nothing to switch into, or null to open platform's page. */
function bannerFor(workspace: CloudWorkspaceResponse | undefined): Banner | null {
  // The check failed, or the workspace is running but this app couldn't sign
  // in: the user can't tell these apart, and either way the fix is to retry.
  if (!workspace || workspace.discoveryFailed || workspace.found) {
    return { title: 'Couldn’t connect to your cloud workspace', text: 'Press Cloud to try again.' }
  }
  return (workspace.status && STATUS_BANNERS[workspace.status]) || null
}

/**
 * State for the Local/Cloud control: which Superagent this window is driving,
 * and how to move.
 *
 * Offered to every desktop user, so Cloud is also how someone without cloud
 * agents finds them. It switches only into a workspace a fresh check finds
 * live. Otherwise a banner says what the workspace is doing, with a link to
 * platform's Cloud Agents page; with no workspace at all, that page opens.
 */
export function useTargetSwitch() {
  const current: ApiTarget = targetIsRemote() ? 'cloud' : 'local'
  const [switching, setSwitching] = useState(false)
  const queryClient = useQueryClient()

  const { openSettings } = useDialogs()
  const isOnline = useIsOnline()

  const { data: platform } = usePlatformAuthStatus()

  // Only ask about the workspace from the LOCAL side. In cloud mode every
  // request goes through the proxy to the deployment, and `getCloudWorkspace`
  // self-gates off the Electron main process — so the deployment would answer
  // "no cloud workspace" about itself. Being in cloud mode is its own proof.
  const canAsk = isElectron() && current === 'local' && platform?.connected === true
  // Never fetched on its own: asked only when Cloud is pressed, so a press never
  // joins a check that started before it.
  const { refetch } = useCloudWorkspace(false, platform?.orgId)

  const switchTo = useCallback(
    async (target: ApiTarget) => {
      if (target === current || switching) return
      if (target === 'cloud') {
        // Not connected: Account is where Connect is, and where the cloud
        // agents card appears once connected.
        if (!canAsk) return openSettings('platform')
        setSwitching(true)
        // Never the cached answer: it can be minutes old, from before a
        // workspace was set up or paused. Offline, React Query would hold the
        // request until the connection returns, so don't ask: "couldn't connect".
        const workspace = isOnline
          ? await refetch({ throwOnError: true }).then(
              (result) => result.data,
              () => undefined,
            )
          : undefined
        if (!workspace?.found || !workspace.hasValidToken) {
          setSwitching(false)
          const cloudAgentsPage =
            platform?.platformBaseUrl && platform.orgId
              ? `${platform.platformBaseUrl}/dashboard/organizations/${platform.orgId}?tab=cloud`
              : null
          const openPlatform = () => {
            if (cloudAgentsPage) void openExternalUrl(cloudAgentsPage)
          }
          const banner = bannerFor(workspace)
          if (!banner) return openPlatform()
          // One id, so pressing again replaces the banner rather than stacking.
          toast(banner.title, {
            id: 'cloud-workspace',
            description: banner.text,
            action: cloudAgentsPage ? { label: 'Platform ↗', onClick: openPlatform } : undefined,
          })
          return
        }
      }
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
    [current, switching, canAsk, openSettings, isOnline, refetch, platform, queryClient],
  )

  return {
    current,
    switching,
    /** Whether to offer the control at all: always, in the desktop app. */
    available: isElectron(),
    switchTo,
  }
}
