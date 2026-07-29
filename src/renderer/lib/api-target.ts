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
  // Publish it on the document root as well.
  //
  // Nothing in the app reads this — it exists so an out-of-process observer
  // (the live suite driving a real window over CDP) can ask which Superagent a
  // renderer settled on without inferring it from whatever chrome happens to be
  // on screen. The sidebar switcher is not that: it is absent from the
  // onboarding wizard, which replaces the whole shell, so "no switcher" reads
  // identically to "switch never happened". Set once, alongside the value it
  // mirrors, so the two cannot drift.
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.apiTarget = target
  }
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
 * Reload onto the root route.
 *
 * Not a plain `reload()`: agent ids are per-deployment, so the route you are
 * standing on almost certainly does not exist on the other side of a switch —
 * reloading in place lands on a 404 of someone else's agent. Electron uses hash
 * history (see `router/history.ts`), where the route lives in the fragment and
 * the document URL must stay pinned to the real `index.html`; the web build uses
 * path history, where `/` is the document.
 */
function reloadAtRoot(): void {
  if (__WEB__) {
    window.location.assign('/')
    return
  }
  window.location.hash = '#/'
  window.location.reload()
}

/**
 * Point this app at a different Superagent. The only way to change target: the
 * live one is frozen, so the preference is recorded and the window reloaded.
 * Recording it also tears down the other renderers (main does that), so the
 * caller only owns this window.
 */
export async function switchTarget(target: ApiTarget): Promise<void> {
  await writePreferredTarget(target)
  reloadAtRoot()
}

/** Return this app to the local Superagent. */
export function switchToLocalTarget(): Promise<void> {
  return switchTarget('local')
}

/** Test seam: returns the module to its pre-boot state. */
export function _resetApiTargetForTest(): void {
  activeTarget = null
  fallbackReason = null
}
