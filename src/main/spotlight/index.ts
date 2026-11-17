import { app } from 'electron'
import path from 'path'
import type { ApiTarget } from '@shared/lib/api-target'
import { serviceHost } from '@shared/lib/background-work'
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

/** Built by scripts/build-spotlight-bridge.sh into build/, shipped as an extra resource. */
function spotlightBridgeDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'spotlight-bridge')
    : path.join(app.getAppPath(), 'build', 'spotlight-bridge')
}

/** Start indexing and handling clicks. macOS only; call once the window and the API are up. */
export function startSpotlight(options: {
  baseUrl(target: ApiTarget): Promise<string | null>
  activation: SpotlightActivationDeps
}): void {
  if (process.platform !== 'darwin' || activation) return
  activation = createSpotlightActivation(options.activation)

  void loadSpotlightIndex(spotlightBridgeDir()).then((index) => {
    if (stopped) return
    if (index) {
      sync = new SpotlightSync({ index, baseUrl: options.baseUrl, activeTarget: options.activation.activeTarget })
      // Registered here rather than with the other services: this is a desktop
      // feature, it starts once the window and the API are up, and it runs
      // whether or not the rest of the services came up.
      serviceHost().register(sync)
      return serviceHost().startService(sync.id)
    } else if (!app.isPackaged) {
      console.log('[Spotlight] Bridge not built; run `npm run build:spotlight-bridge` to index this app.')
    }
  }).catch((error) => {
    console.error('[Spotlight] Could not start indexing:', error)
  })

  if (pendingIdentifier) {
    const identifier = pendingIdentifier
    pendingIdentifier = null
    activate(activation, identifier)
  }
}

/** A `continue-activity` from macOS. True when it was a click on one of our results. */
export function handleSpotlightActivity(type: string, userInfo: unknown): boolean {
  if (type !== SPOTLIGHT_ACTIVITY_TYPE) return false
  const identifier = spotlightIdentifier(userInfo)
  if (!identifier) return true
  if (activation) activate(activation, identifier)
  else pendingIdentifier = identifier
  return true
}

/** Something in a Superagent probably changed; re-index soon. */
export function requestSpotlightSync(): void {
  sync?.requestSync()
}

/** A main-window renderer mounted: open a result that was waiting on a target switch. */
export function resumeSpotlightAfterSwitch(): void {
  activation?.resumeAfterSwitch().catch((error) => {
    console.error('[Spotlight] Could not open the result waiting on a switch:', error)
  })
}

function activate(target: SpotlightActivation, identifier: string): void {
  target.activate(identifier).catch((error) => {
    console.error('[Spotlight] Could not open a result:', error)
  })
}

/** The main window did not make a switch main asked for; forget the result waiting on it. */
export function spotlightSwitchDeclined(): void {
  activation?.switchDeclined()
}

export function stopSpotlight(): void {
  stopped = true
  sync?.stop()
}
