import { readsHostFolders, runsHostGit, runsInAppSandbox, supportsComputerUse, updatesItself } from '@shared/lib/facts/capabilities'
import { targetIsRemote } from './api-target'
import { isElectron } from './env'
import { clientFacts, serverFacts } from './facts'

/**
 * What this window may offer, asked by name. Each answer is about one side:
 * this window's app and computer (client facts), the machine running the API it
 * drives (server facts), or whether those are the same machine (the target).
 * Gate on these rather than combining facts at the call site. See
 * `docs/facts.md`.
 */

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
 * STT availability (`/api/voice/configured`), and runtime readiness all describe
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

/**
 * Whether the agents' machine can run computer use: the same rule the server
 * applies before it runs a computer-use tool. Unknown server facts read as no.
 */
export function computerUseSupported(): boolean {
  const server = serverFacts()
  return server !== null && supportsComputerUse(server)
}

/**
 * Whether this window's app updates itself, so offers its own update checks. A
 * question about the client: a Store build connected to a cloud workspace still
 * gets its updates from the Store.
 */
export function appUpdatesItself(): boolean {
  return updatesItself(clientFacts())
}

/**
 * Whether the agents run inside the App Sandbox: the Mac App Store build
 * driving its own API. Settings then lists what the sandbox leaves out
 * (`SandboxNotice`). Unknown server facts read as no.
 */
export function agentsRunInAppSandbox(): boolean {
  const server = serverFacts()
  return server !== null && runsInAppSandbox(server)
}

/**
 * Whether Settings has a Computer Use tab: the desktop app driving its own
 * machine, unless that machine's sandbox leaves computer use out entirely. On
 * Linux the tab stays, to say computer use needs macOS or Windows.
 */
export function offersComputerUseSettings(): boolean {
  return canUseHostFeatures() && !agentsRunInAppSandbox()
}

/**
 * Whether this window hands the server folders of this computer by path: to
 * mount one as an agent's drive, or to copy a dropped one in. That needs the
 * desktop app driving its own machine, outside the sandbox. Without it a
 * dropped folder uploads its files instead.
 */
export function usesHostFolderPaths(): boolean {
  const server = serverFacts()
  return canUseHostFeatures() && server !== null && readsHostFolders(server)
}

/**
 * Whether a skillset can be a private repository, cloned with a token: the
 * server runs git. A server that didn't say is an older deployment, which did.
 */
export function offersPrivateSkillsets(): boolean {
  const server = serverFacts()
  return server === null || runsHostGit(server)
}

/*
 * The desktop app's own Mac integrations. Each acts on the computer the window
 * runs on, whichever Superagent it drives, so each asks the client half, and
 * the App Sandbox allows none of them.
 */

/** Whether Settings offers Keep Awake, which stops the Mac sleeping with its lid closed (`pmset` under sudo). */
export function keepsMacAwake(): boolean {
  const client = clientFacts()
  return client.shell === 'electron' && client.os === 'darwin' && !runsInAppSandbox(client)
}

/** Whether a dashboard can be added to the Dock, as a launcher app in ~/Applications. */
export function addsToDock(): boolean {
  const client = clientFacts()
  return client.shell === 'electron' && client.os === 'darwin' && !runsInAppSandbox(client)
}

/** Whether the attachment menus list recently used files, which Spotlight finds. */
export function listsRecentFiles(): boolean {
  return !!window.electronAPI?.getRecentFiles && !runsInAppSandbox(clientFacts())
}
