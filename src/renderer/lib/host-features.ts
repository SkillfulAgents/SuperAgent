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
 * whichever Superagent is being driven. Only local IPC and the
 * install-it-yourself affordances have to be told.
 */
export function canUseHostFeatures(): boolean {
  return isElectron() && !targetIsRemote()
}
