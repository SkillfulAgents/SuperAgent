import { coerceApiTarget, type ApiTarget } from '@shared/lib/api-target'
import { getSettings, mutateSettings } from '@shared/lib/config/settings'

/**
 * Persistence for "which Superagent is this desktop app driving?".
 *
 * This lives in main-owned settings rather than renderer `localStorage` because
 * the app has more than one renderer — the main window and the quick-dispatch
 * launcher are separate BrowserWindows — and they must never disagree about
 * which machine executes work. Everything else this decision depends on (the
 * deployment token, the proxy key, the target itself) is already main-owned.
 */

/**
 * The target the user last chose. This is an *intent*, not a promise — it is
 * stored on a machine whose workspace may since have been disconnected, so
 * nothing may act on it before `resolveApiTarget` has checked it against what
 * is actually reachable.
 */
export function readPreferredApiTarget(): ApiTarget {
  return coerceApiTarget(getSettings().apiTarget)
}

/**
 * Record the target for subsequent renderer boots. Deliberately does not touch
 * any live renderer: the target is frozen for a renderer's lifetime, so the
 * caller is responsible for reloading or recreating the windows.
 */
export function writePreferredApiTarget(target: ApiTarget): void {
  mutateSettings((settings) => {
    settings.apiTarget = target
  })
}
