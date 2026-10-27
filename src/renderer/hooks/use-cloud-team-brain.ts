import { useState } from 'react'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useTeamBrainDevOverride } from '@renderer/components/team-brain/team-brain-dev-override'
import { canUseHostFeatures } from '@renderer/lib/capabilities'
import type { CloudTeamBrain } from '@renderer/lib/team-brain/team-brain-cloud'
import { cloudTeamBrain } from '@renderer/lib/team-brain/team-brain-cloud-fixture'
import { useCloudWorkspace } from './use-cloud-workspace'
import { usePlatformAuthStatus } from './use-platform-auth'
import { cloudAgentsPageUrl } from './use-target-switch'

/**
 * Whether set-up offers connecting to the organization's Team Brain in its cloud workspace, beside setting one up here:
 * the desktop app driving the Superagent on its own computer. A cloud workspace, from this app or a browser, and any
 * web deployment are where an organization's Team Brain is set up, so they only set up. Dev builds can stand either in
 * (team-brain-dev-override).
 */
export function useOffersCloudTeamBrain(): boolean {
  const { window } = useTeamBrainDevOverride()
  return window === 'live' ? canUseHostFeatures() : window === 'desktop'
}

/** What looking for the cloud's Team Brain found, with what to do about it where there is something to do. */
export type CloudTeamBrainLookup =
  | { state: 'checking' }
  /** No Gamut account connected, so there is no workspace to look in. */
  | { state: 'signed-out' }
  /** The org has no cloud workspace; platform's page is where one is set up. */
  | { state: 'no-workspace'; platformPage: string | null }
  /** It has one, not running: setting up, going to sleep or asleep, or failed. */
  | { state: 'not-running'; status: 'starting' | 'asleep' | 'error'; platformPage: string | null }
  /** Offline, the check failed, or the workspace is running but wouldn't let this app in. Trying again is the fix. */
  | { state: 'unreachable' }
  /** The workspace is running and has no Team Brain set up. */
  | { state: 'no-brain' }
  | { state: 'found'; brain: CloudTeamBrain }

// Platform's statuses for a workspace that exists but isn't running; one missing here reads as no workspace.
const NOT_RUNNING: Record<string, 'starting' | 'asleep' | 'error'> = {
  pending: 'starting',
  deploying: 'starting',
  destroying: 'asleep',
  destroyed: 'asleep',
  error: 'error',
}

const STAND_IN_WORKSPACE = 'acme.gamut.cloud'

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).host : null
  } catch {
    return null
  }
}

/**
 * Looks for the organization's Team Brain from the desktop: its Gamut account, then its cloud workspace, as the
 * Local/Cloud switch does (`useTargetSwitch`), then, while the workspace can't be asked yet, a stand-in Team Brain in a
 * workspace found running. The workspace is only asked while `enabled` (set-up is open). Dev builds can stand any answer in.
 */
export function useCloudTeamBrain(enabled: boolean): CloudTeamBrainLookup & { checkAgain: () => void } {
  const dev = useTeamBrainDevOverride().cloud
  const isOnline = useIsOnline()
  const platformStatus = usePlatformAuthStatus()
  const platform = platformStatus.data
  // Asked only from this computer's side, as the switch asks: in cloud mode the deployment would answer about itself.
  const canAsk = enabled && dev === 'live' && canUseHostFeatures() && platform?.connected === true && isOnline
  const workspace = useCloudWorkspace(canAsk, platform?.orgId)
  const platformPage = cloudAgentsPageUrl(platform)
  // A check asked for says so until its answer is in; the query's own refetches (a window coming back into focus) don't.
  const [rechecking, setRechecking] = useState(false)
  const checkAgain = () => {
    if (!canAsk) return
    setRechecking(true)
    void workspace.refetch().finally(() => setRechecking(false))
  }

  const found = (address: string): CloudTeamBrainLookup => ({ state: 'found', brain: cloudTeamBrain(address) })
  const answer = ((): CloudTeamBrainLookup => {
    switch (dev) {
      case 'signed-out':
      case 'no-workspace':
      case 'unreachable':
      case 'no-brain':
        return dev === 'no-workspace' ? { state: dev, platformPage } : { state: dev }
      case 'asleep':
        return { state: 'not-running', status: 'asleep', platformPage }
      case 'found':
        return found(STAND_IN_WORKSPACE)
    }
    if (platformStatus.isPending) return { state: 'checking' }
    if (!platform?.connected || !canUseHostFeatures()) return { state: 'signed-out' }
    if (!isOnline || workspace.isError) return { state: 'unreachable' }
    if (!workspace.data || rechecking) return { state: 'checking' }
    const { found: deployed, hasValidToken, discoveryFailed, status, deploymentUrl } = workspace.data
    if (discoveryFailed || (deployed && !hasValidToken)) return { state: 'unreachable' }
    if (deployed) return found(hostOf(deploymentUrl) ?? STAND_IN_WORKSPACE)
    const notRunning = status ? NOT_RUNNING[status] : undefined
    return notRunning ? { state: 'not-running', status: notRunning, platformPage } : { state: 'no-workspace', platformPage }
  })()
  return { ...answer, checkAgain }
}
