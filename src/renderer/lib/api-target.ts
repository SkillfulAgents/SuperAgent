/**
 * Which Superagent the UI is driving: the one on this laptop, or the
 * organization's cloud workspace.
 *
 * The target is chosen once, at boot, and does not change for the lifetime of
 * the renderer — switching reloads the window. That is not a shortcut: several
 * hooks branch on whether auth mode is on and call *different hooks* on each
 * side (behind `rules-of-hooks` disables), so a target that changed under a
 * mounted tree would be a hooks-order crash rather than a re-render. Reload
 * makes the target a boot-time constant, which is what that code already
 * assumes.
 *
 * Cloud requests still go to loopback — see `api/routes/cloud-proxy.ts` for why
 * the renderer cannot talk to the deployment directly. All that changes here is
 * the prefix `getApiBaseUrl()` returns.
 */

const STORAGE_KEY = 'superagent.apiTarget'

export type ApiTarget = 'local' | 'cloud'

/** Why a requested cloud target was not honoured. Null when nothing was denied. */
export type TargetFallbackReason = 'no-workspace' | null

let activeTarget: ApiTarget | null = null
let fallbackReason: TargetFallbackReason = null

/**
 * The target the user last chose. This is an *intent*, not a promise — it is
 * stored on a machine whose workspace may since have been disconnected, so
 * nothing may act on it before {@link resolveApiTarget} has checked it.
 */
export function readPreferredTarget(): ApiTarget {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'cloud' ? 'cloud' : 'local'
  } catch {
    // Storage can be unavailable (private mode, a locked-down embedder). Local
    // is the answer that is always correct and never surprising.
    return 'local'
  }
}

/**
 * Record the target for the next boot. The caller is responsible for the reload
 * — this deliberately does not touch the live target, which is frozen.
 */
export function writePreferredTarget(target: ApiTarget): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, target)
  } catch {
    // Nothing useful to do: the switch simply won't survive a restart.
  }
}

/**
 * Settle the target for this renderer, given what the main process says is
 * actually reachable. `cloudBaseUrl` is null when there is no cloud workspace or
 * no live token for it.
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

/** Called once by `initApiBaseUrl()`, before the first render. */
export function setActiveTarget(target: ApiTarget, fallback: TargetFallbackReason): void {
  activeTarget = target
  fallbackReason = fallback
}

/**
 * The target in force. Throws before initialization rather than assuming
 * `'local'`: a caller reading this too early is making a routing decision
 * before there is one to read, and a plausible wrong answer would send cloud
 * traffic to the laptop without anyone noticing.
 */
export function getActiveTarget(): ApiTarget {
  if (activeTarget === null) {
    throw new Error('API target read before initApiBaseUrl() resolved it')
  }
  return activeTarget
}

/** Whether the UI is driving a remote deployment rather than this machine. */
export function targetIsRemote(): boolean {
  return getActiveTarget() === 'cloud'
}

/**
 * Set when a stored `cloud` preference could not be honoured this boot, so the
 * UI can say why it is showing local data. Safe to read before initialization
 * (it is null until something is denied).
 */
export function getTargetFallbackReason(): TargetFallbackReason {
  return fallbackReason
}

/** Test seam: returns the module to its pre-boot state. */
export function _resetApiTargetForTest(): void {
  activeTarget = null
  fallbackReason = null
}
