import { coerceApiTarget, resolveApiTarget, type ResolvedApiTarget } from '@shared/lib/api-target'
import {
  readPreferredApiTarget,
  writePreferredApiTarget,
} from '@shared/lib/services/api-target-preference'
import { closeQuickDispatchWindow } from './quick-dispatch-window'

/**
 * Main-process side of "which Superagent is this app driving?".
 *
 * Main settles it, not the renderers: it owns the stored preference, the
 * deployment token and the per-boot proxy key, and the app has more than one
 * renderer. They must never disagree about which machine executes work.
 */

/**
 * The answer handed to a renderer at boot. `cloudBaseUrl` is null when there is
 * no cloud workspace or no live token for one — which is also the validation
 * step for a stored "cloud" preference, so a disconnected account degrades to a
 * working local app rather than a wall of failures.
 */
export function resolveApiTargetForRenderer(
  localBaseUrl: string,
  cloudBaseUrl: string | null,
): ResolvedApiTarget {
  const { target, fallback } = resolveApiTarget(readPreferredApiTarget(), cloudBaseUrl)
  return {
    target,
    baseUrl: target === 'cloud' && cloudBaseUrl ? cloudBaseUrl : localBaseUrl,
    fallback,
  }
}

/**
 * Record a target for subsequent boots. The switch is a reload, not a live swap
 * (several hooks branch on auth mode and call different hooks on each side, so a
 * target that changed under a mounted tree is a hooks-order crash). The caller
 * reloads the window it is switching.
 *
 * Tearing down the launcher is the load-bearing part: it is pre-created at
 * startup and destroyed only at quit, so it caches its target — and its base
 * URL — for the whole session. Left alone it would keep dispatching to the old
 * Superagent after the main window switched. It is recreated on next use.
 */
export function applyPreferredApiTarget(target: unknown): void {
  writePreferredApiTarget(coerceApiTarget(target))
  closeQuickDispatchWindow()
}
