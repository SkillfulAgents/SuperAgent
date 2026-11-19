import { coerceApiTarget, type ApiTarget } from '@shared/lib/api-target'
import { getSettings, mutateSettings, type AppSettings } from '@shared/lib/config/settings'

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
export async function readPreferredApiTarget(): Promise<ApiTarget> {
  return preferredApiTargetFrom(await getSettings())
}

/** {@link readPreferredApiTarget} from settings already read. */
export function preferredApiTargetFrom(settings: Pick<AppSettings, 'apiTarget'>): ApiTarget {
  return coerceApiTarget(settings.apiTarget)
}

/**
 * Record the target for subsequent renderer boots. Deliberately does not touch
 * any live renderer: the target is frozen for a renderer's lifetime, so the
 * caller is responsible for reloading or recreating the windows.
 */
export async function writePreferredApiTarget(target: ApiTarget): Promise<void> {
  await mutateSettings((settings) => {
    settings.apiTarget = target
  })
}
