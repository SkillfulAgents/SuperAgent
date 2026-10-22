import { app } from 'electron'
import path from 'path'
import type { ApiTarget } from '@shared/lib/api-target'
import { loadSpotlightIndex } from './spotlight-bridge'
import { SpotlightSync } from './spotlight-sync'
import {
  createSpotlightActivation,
  spotlightIdentifier,
  SPOTLIGHT_ACTIVITY_TYPE,
  type SpotlightActivation,
  type SpotlightActivationDeps,
} from './spotlight-activation'

/**
 * The app's entries in macOS Spotlight: agents, dashboards and recent sessions
 * of both Superagents, searchable from Spotlight's in-app scope, and what a
 * click on one opens. See docs/spotlight.md.
 */

export { SPOTLIGHT_ACTIVITY_TYPE }

let sync: SpotlightSync | null = null
let activation: SpotlightActivation | null = null
let stopped = false
/** A click that launched the app arrives before the app can act on it. */
let pendingIdentifier: string | null = null

/** Built by scripts/build-macos-bridges.sh into build/, shipped as an extra resource. */
function spotlightBridgeDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'spotlight-bridge')
    : path.join(app.getAppPath(), 'build', 'spotlight-bridge')
}

/** Start indexing and handling clicks. macOS only; call once the window and the API are up. */
export function startSpotlight(options: {
  baseUrl(target: ApiTarget): string | null
  activation: SpotlightActivationDeps
}): void {
  if (process.platform !== 'darwin' || activation) return
  activation = createSpotlightActivation(options.activation)

  void loadSpotlightIndex(spotlightBridgeDir()).then((index) => {
    if (stopped) return
    if (index) {
      sync = new SpotlightSync({ index, baseUrl: options.baseUrl, activeTarget: options.activation.activeTarget })
      sync.start()
    } else if (!app.isPackaged) {
      console.log('[Spotlight] Bridge not built; run `npm run build:macos-bridges` to index this app.')
    }
  })

  if (pendingIdentifier) {
    const identifier = pendingIdentifier
    pendingIdentifier = null
    activation.activate(identifier)
  }
}

/** A `continue-activity` from macOS. True when it was a click on one of our results. */
export function handleSpotlightActivity(type: string, userInfo: unknown): boolean {
  if (type !== SPOTLIGHT_ACTIVITY_TYPE) return false
  const identifier = spotlightIdentifier(userInfo)
  if (!identifier) return true
  if (activation) activation.activate(identifier)
  else pendingIdentifier = identifier
  return true
}

/** Something in a Superagent probably changed; re-index soon. */
export function requestSpotlightSync(): void {
  sync?.requestSync()
}

/** A main-window renderer mounted: open a result that was waiting on a target switch. */
export function resumeSpotlightAfterSwitch(): void {
  activation?.resumeAfterSwitch()
}

/** The main window did not make a switch main asked for; forget the result waiting on it. */
export function spotlightSwitchDeclined(): void {
  activation?.switchDeclined()
}

export function stopSpotlight(): void {
  stopped = true
  sync?.stop()
}
