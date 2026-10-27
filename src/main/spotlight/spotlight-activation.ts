import type { ApiTarget } from '@shared/lib/api-target'
import { parseSpotlightId, type SpotlightRef } from './spotlight-items'

/** The activity type macOS continues the app with when a Spotlight result is clicked. */
export const SPOTLIGHT_ACTIVITY_TYPE = 'com.apple.corespotlightitem'

/**
 * How long a result from the other Superagent waits for the switch to land.
 * A refused switch says so (`switchDeclined`); this bounds the cases where
 * nothing says anything, such as a window closed mid-switch.
 */
export const PENDING_SWITCH_TTL_MS = 60_000

/** The clicked item's identifier, from the activity's `userInfo`. */
export function spotlightIdentifier(userInfo: unknown): string | null {
  if (!userInfo || typeof userInfo !== 'object') return null
  const id = (userInfo as Record<string, unknown>).kCSSearchableItemActivityIdentifier
  return typeof id === 'string' && id ? id : null
}

export interface SpotlightActivationDeps {
  /** Which Superagent the app is driving now. */
  activeTarget(): ApiTarget
  openAgent(agentSlug: string, sessionId: string | null): void
  openDashboard(agentSlug: string, dashboardSlug: string): void
  showMainWindow(): void
  /** Ask the main window to switch, through the same checks as its own Local/Cloud control. */
  requestTargetSwitch(target: ApiTarget): void
  now?: () => number
}

/**
 * What a click on one of the app's Spotlight results does.
 *
 * A result from the Superagent the app is driving opens directly. One from the
 * other side first asks the window to switch, and is opened once the reloaded
 * window says it is ready (`resumeAfterSwitch`), so it is resolved against the
 * Superagent it came from.
 */
export function createSpotlightActivation(deps: SpotlightActivationDeps) {
  const now = deps.now ?? Date.now
  let pending: { ref: SpotlightRef; at: number } | null = null

  function open(ref: SpotlightRef): void {
    switch (ref.kind) {
      case 'agent':
        deps.openAgent(ref.agentSlug, null)
        break
      case 'session':
        deps.openAgent(ref.agentSlug, ref.sessionId)
        break
      case 'dashboard':
        deps.openDashboard(ref.agentSlug, ref.dashboardSlug)
        break
      case 'workspace':
        deps.showMainWindow()
        break
    }
  }

  return {
    activate(identifier: string): void {
      const ref = parseSpotlightId(identifier)
      pending = null
      if (!ref) {
        deps.showMainWindow()
        return
      }
      if (ref.target === deps.activeTarget()) {
        open(ref)
        return
      }
      if (ref.kind !== 'workspace') pending = { ref, at: now() }
      deps.requestTargetSwitch(ref.target)
    },

    /**
     * Called when a main-window renderer has mounted and is ready to receive
     * commands. Opens the result that was waiting on a switch, if the app is
     * now driving its Superagent.
     */
    resumeAfterSwitch(): void {
      if (!pending) return
      if (now() - pending.at > PENDING_SWITCH_TTL_MS) {
        pending = null
        return
      }
      // Not switched (yet): a renderer mounting on the old side, such as a
      // window recreated to carry the switch request itself.
      if (pending.ref.target !== deps.activeTarget()) return
      const { ref } = pending
      pending = null
      open(ref)
    },

    /**
     * The window did not switch (the workspace is asleep, the user is not
     * connected, a switch was already under way). The result is dropped, so a
     * later switch of the user's own does not open it.
     */
    switchDeclined(): void {
      pending = null
    },
  }
}

export type SpotlightActivation = ReturnType<typeof createSpotlightActivation>
