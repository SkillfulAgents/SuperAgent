import { coerceApiTarget, resolveApiTarget, type ResolvedApiTarget } from '@shared/lib/api-target'
import {
  readPreferredApiTarget,
  writePreferredApiTarget,
} from '@shared/lib/services/api-target-preference'
import { startCloudBootPrefetch } from '@shared/lib/services/cloud-boot-prefetch'
import { closeQuickDispatchWindow } from './quick-dispatch-window'
import { closeAllDashboardWindows } from './dashboard-window'
import { refreshTrayMenu } from './tray'
import { refreshAppMenu } from './app-menu'

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
 * Tearing down the other windows is the load-bearing part. Each resolved its
 * target once and holds it for its own lifetime:
 *
 * - The launcher is pre-created at startup and destroyed only at quit, so it
 *   caches its base URL for the whole session. Left alone it would keep
 *   dispatching to the old Superagent after the main window switched. It is
 *   recreated on next use.
 * - Dashboard popouts have already loaded a URL built from the old base. They
 *   would sit there showing the previous deployment's dashboard, under chrome
 *   identical to the new one's.
 *
 * It is also the earliest moment anyone knows a cloud boot is coming — the
 * reload has not started yet — so it is where the workspace's first round trips
 * begin. See `cloud-boot-prefetch.ts`.
 */
export function applyPreferredApiTarget(target: unknown): void {
  const next = coerceApiTarget(target)
  writePreferredApiTarget(next)
  closeQuickDispatchWindow()
  closeAllDashboardWindows()
  if (next === 'cloud') startCloudBootPrefetch()
  // The tray and the app menu's Agents submenu resolve the effective base URL
  // on every fetch, so the preference write above is all they need — but they
  // poll on a 30s interval, which would leave the previous Superagent's agents
  // on screen for up to that long. Kick them now.
  refreshTrayMenu()
  refreshAppMenu()
}
