import { targetIsRemote } from './api-target'
import { isElectron } from './env'

/**
 * Whether this window may offer features that act on the computer it is running
 * on.
 *
 * Every one of these sites used to ask `isElectron()`, and that was the same
 * question for as long as the desktop app could only ever drive the Superagent
 * on its own machine. In cloud mode it is still Electron — the IPC bridge, the
 * directory picker, the Finder call all still work — but they now act on the
 * *wrong* machine: they reach this laptop while the agents, their files and
 * their runtime are somewhere else. A host path handed to the deployment is
 * meaningless there, and worse, may coincidentally exist.
 *
 * `isElectron()` is still the right question for the window itself — traffic
 * lights, drag regions, the tray, app updates, the global shortcut. This is the
 * right question for anything that reaches a filesystem or a runtime that is
 * supposed to be the agents'.
 *
 * Note what is deliberately NOT gated on this. Where the answer comes from the
 * *server*, it already comes from the machine that owns it and needs no gate:
 * the host-browser providers and their Chrome profiles (`detectAllProviders()`),
 * STT availability (`/api/stt/configured`), and runtime readiness all describe
 * whichever Superagent is being driven.
 *
 * And do NOT reach for this where the feature acts on the *server* and the web
 * build legitimately offers it — the runtime wizard step, the container-setup
 * dialog, firewall detection. This predicate is false for every browser, so
 * using it there withdraws the feature from ordinary web deployments too, where
 * the API being configured is exactly the machine the user means. Those want a
 * bare `!targetIsRemote()`: what disqualifies them is that the machine is out of
 * reach, not that there is no IPC bridge.
 *
 * Truth table across the three reachable configurations, the decision rule, and
 * the full inventory of gated sites: `docs/cloud-workspace.md` § Capability
 * gating.
 */
export function canUseHostFeatures(): boolean {
  return isElectron() && !targetIsRemote()
}
