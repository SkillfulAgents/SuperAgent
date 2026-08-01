/**
 * Which Superagent the UI is driving: the one on this laptop, or the
 * organization's cloud workspace.
 *
 * Pure types + resolution, shared by the main process (which owns the stored
 * preference and decides the answer) and the renderer (which consumes it).
 * Nothing here touches settings, IPC or the network.
 */

export type ApiTarget = 'local' | 'cloud'

/** Why a requested cloud target was not honoured. Null when nothing was denied. */
export type TargetFallbackReason = 'no-workspace' | null

/** The settled answer handed to a renderer at boot. */
export interface ResolvedApiTarget {
  target: ApiTarget
  /** Base URL every call site prefixes — loopback in both cases (see cloud-proxy.ts). */
  baseUrl: string
  fallback: TargetFallbackReason
}

/**
 * Narrow an untrusted value (a hand-edited settings file, an older version)
 * to a target. Anything unrecognized reads as local: the answer that is always
 * correct and never surprising.
 */
export function coerceApiTarget(value: unknown): ApiTarget {
  return value === 'cloud' ? 'cloud' : 'local'
}

/**
 * Settle the target, given what is actually reachable. `cloudBaseUrl` is null
 * when there is no cloud workspace or no live token for one.
 *
 * **Fails closed to local.** Someone who left the app in cloud mode and then
 * disconnected their platform account gets a working local app and one notice,
 * not a wall of failed requests against a workspace that is no longer theirs.
 */
export function resolveApiTarget(
  preferred: ApiTarget,
  cloudBaseUrl: string | null,
): { target: ApiTarget; fallback: TargetFallbackReason } {
  if (preferred !== 'cloud') return { target: 'local', fallback: null }
  if (!cloudBaseUrl) return { target: 'local', fallback: 'no-workspace' }
  return { target: 'cloud', fallback: null }
}
