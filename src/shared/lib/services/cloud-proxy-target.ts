import { readCloudWorkspaceRecord } from '@shared/lib/platform-auth/cloud-workspace-record'
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
 * comes back from `settings.json`, which is on disk and outlives the process
 * that wrote it.
 */
export function resolveCloudProxyTarget(): CloudProxyTarget | null {
  const record = readCloudWorkspaceRecord()
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
 * another full round-trip to the platform. Inside the cooldown this reports
 * "no fresh target", so the request fails once rather than driving a mint loop.
 */
const REFRESH_COOLDOWN_MS = 30_000

let inFlightRefresh: Promise<CloudProxyTarget | null> | null = null
let lastRefreshStartedAt = 0

export function refreshCloudProxyTarget(): Promise<CloudProxyTarget | null> {
  if (inFlightRefresh) return inFlightRefresh
  if (Date.now() - lastRefreshStartedAt < REFRESH_COOLDOWN_MS) return Promise.resolve(null)

  lastRefreshStartedAt = Date.now()
  // getCloudWorkspace is documented never to throw; the catch is here so a
  // regression there degrades to "no fresh target" instead of failing a request
  // with a 500.
  inFlightRefresh = getCloudWorkspace({ forceTokenRefresh: true })
    .then(() => resolveCloudProxyTarget())
    .catch(() => null)
    .finally(() => {
      inFlightRefresh = null
    })
  return inFlightRefresh
}

/** Test seam: clears the single-flight promise and the cooldown. */
export function _resetCloudProxyRefreshForTest(): void {
  inFlightRefresh = null
  lastRefreshStartedAt = 0
}
