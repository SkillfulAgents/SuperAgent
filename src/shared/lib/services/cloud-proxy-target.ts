import type { AppSettings, CloudWorkspaceSettings } from '@shared/lib/config/settings'
import { cloudWorkspaceRecordFrom, readCloudWorkspaceRecord } from '@shared/lib/platform-auth/cloud-workspace-record'
import { getCloudWorkspace, isDeploymentUrlAllowed } from './cloud-workspace-service'

/** Where the cloud proxy forwards to, and the credential it presents. */
export interface CloudProxyTarget {
  /** Origin of the remote deployment, with no trailing slash. */
  deploymentUrl: string
  /** Deployment session token, presented as `Authorization: Bearer`. */
  token: string
}

/**
 * The deployment token currently in hand, or null if there is nothing to
 * forward to.
 *
 * Deliberately does **not** check the record's expiry. The deployment is the
 * authority on whether its own token is still good, and a local clock running
 * fast would otherwise refuse a token that still works. An expired token simply
 * 401s, which the proxy already handles by re-minting — one wasted round-trip,
 * once, versus a class of failure that only reproduces on a skewed machine.
 *
 * The URL is re-checked on every read rather than trusted from the mint: it
 * comes back from the stored settings, which outlive the process that wrote
 * them.
 */
export async function resolveCloudProxyTarget(): Promise<CloudProxyTarget | null> {
  return targetOf(await readCloudWorkspaceRecord())
}

/** {@link resolveCloudProxyTarget} from settings already read. */
export function cloudProxyTargetFrom(settings: Pick<AppSettings, 'cloudWorkspace'>): CloudProxyTarget | null {
  return targetOf(cloudWorkspaceRecordFrom(settings))
}

function targetOf(record: CloudWorkspaceSettings | null): CloudProxyTarget | null {
  if (!record?.token || !record.deploymentUrl) return null
  if (!isDeploymentUrlAllowed(record.deploymentUrl)) return null
  return {
    deploymentUrl: record.deploymentUrl.replace(/\/+$/, ''),
    token: record.token,
  }
}

/**
 * Force a fresh deployment token and return the new target, or null if none
 * could be obtained.
 *
 * Single-flight: a session expiring takes out every in-flight request at once,
 * and each of them would otherwise kick off its own grant + exchange. They all
 * wait on the same mint instead.
 *
 * Rate-limited on top of that, because single-flight alone does not bound the
 * pathological case: a deployment that rejects even a freshly minted token (the
 * user was banned, or removed from the org) turns every subsequent request into
 * another full round-trip to the platform. Inside the cooldown no new mint is
 * started — but the token the last one produced is still handed out, so a
 * straggler arriving just after the flight settles is not failed for it.
 */
const REFRESH_COOLDOWN_MS = 30_000

let inFlightRefresh: Promise<CloudProxyTarget | null> | null = null
let lastRefreshStartedAt = 0
let lastRefreshSucceeded = false

export function refreshCloudProxyTarget(): Promise<CloudProxyTarget | null> {
  if (inFlightRefresh) return inFlightRefresh

  if (Date.now() - lastRefreshStartedAt < REFRESH_COOLDOWN_MS) {
    // A refresh that just finished leaves a good token behind, and the stragglers
    // of the 401 burst that triggered it arrive milliseconds after it settles —
    // too late to join the single flight, and turning them away would fail
    // requests a working token is already sitting there for. Read the record
    // again rather than handing back a remembered target, so a token cleared in
    // the meantime (account switch, disconnect) is not resurrected here.
    // A refresh that *failed* still declines: the mint is what we are protecting
    // the platform from, but replaying against a token we just watched be
    // rejected only doubles the traffic to the deployment.
    return lastRefreshSucceeded ? resolveCloudProxyTarget() : Promise.resolve(null)
  }

  lastRefreshStartedAt = Date.now()
  // getCloudWorkspace is documented never to throw; the catch is here so a
  // regression there degrades to "no fresh target" instead of failing a request
  // with a 500.
  inFlightRefresh = getCloudWorkspace({ forceTokenRefresh: true })
    // The status is what says whether a token was actually minted. The record
    // is not: a failed re-mint deliberately leaves the old one in place (better
    // than nothing for a caller that hasn't been rejected yet), so reading it
    // back would hand this caller the very token the deployment just refused
    // and call it fresh.
    .then((status) => (status.hasValidToken ? resolveCloudProxyTarget() : null))
    .catch(() => null)
    .then((target) => {
      lastRefreshSucceeded = target !== null
      return target
    })
    .finally(() => {
      inFlightRefresh = null
    })
  return inFlightRefresh
}

/** Test seam: clears the single-flight promise and the cooldown. */
export function _resetCloudProxyRefreshForTest(): void {
  inFlightRefresh = null
  lastRefreshStartedAt = 0
  lastRefreshSucceeded = false
}
