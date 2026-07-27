import type { ApiTarget, TargetFallbackReason } from '@shared/lib/api-target'

/**
 * Which Superagent this renderer is driving, for the code that needs to branch
 * on it.
 *
 * The target is chosen once, at boot, by the *main* process — see
 * `services/api-target-preference.ts` for why the preference is not stored
 * here — and does not change for the lifetime of the renderer. Switching
 * reloads the window. That is not a shortcut: several hooks branch on whether
 * auth mode is on and call *different hooks* on each side (behind
 * `rules-of-hooks` disables), so a target that changed under a mounted tree
 * would be a hooks-order crash rather than a re-render. Reload makes the target
 * a boot-time constant, which is what that code already assumes.
 *
 * Cloud requests still go to loopback — see `api/routes/cloud-proxy.ts` for why
 * the renderer cannot talk to the deployment directly. All that changes is the
 * prefix `getApiBaseUrl()` returns.
 */

export type { ApiTarget, TargetFallbackReason }

let activeTarget: ApiTarget | null = null
let fallbackReason: TargetFallbackReason = null

/**
 * Called once by `initApiBaseUrl()`, before the first render.
 *
 * Throws on a second call. The target is not merely conventionally stable — code
 * branches on it *between hook calls* (`useAuthSession`, `useResolverAgents`),
 * so a value that changed mid-lifetime would reorder hooks and crash the tree.
 * Enforcing single-assignment here makes that structurally impossible rather
 * than a rule someone has to remember; switching targets goes through a reload.
 */
export function setActiveTarget(target: ApiTarget, fallback: TargetFallbackReason): void {
  if (activeTarget !== null) {
    throw new Error('API target is already settled and cannot change without a reload')
  }
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

/**
 * Record a target for subsequent boots. Deliberately does not touch the live
 * target, which is frozen — the caller reloads. Main tears down the other
 * renderers so none of them keeps driving the previous Superagent.
 */
export async function writePreferredTarget(target: ApiTarget): Promise<void> {
  await window.electronAPI?.setPreferredApiTarget?.(target)
}

/**
 * Return this app to the local Superagent. The only way to change target: the
 * live one is frozen, so the preference is recorded and the window reloaded.
 * Main tears down the other renderers as part of recording it.
 */
export async function switchToLocalTarget(): Promise<void> {
  await writePreferredTarget('local')
  window.location.reload()
}

/** Test seam: returns the module to its pre-boot state. */
export function _resetApiTargetForTest(): void {
  activeTarget = null
  fallbackReason = null
}
