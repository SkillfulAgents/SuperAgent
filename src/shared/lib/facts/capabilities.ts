import type { ClientFacts, DesktopDistribution, ServerDistribution, ServerFacts } from './facts-schema'

/**
 * What an install can do, as pure functions of its facts. The server asks the
 * server ones of `getServerFacts()`; a renderer asks the same function of the
 * facts of the server it drives (`renderer/lib/capabilities.ts`), so the two
 * can't disagree.
 */

/**
 * Whether agents can drive the apps on the desktop of their machine. There is a
 * backend for macOS and Windows only, and the App Sandbox forbids it: a
 * sandboxed app may not control other apps. The container offers its script
 * tool on the same answer (`HOST_COMPUTER_USE`).
 */
export function supportsComputerUse(server: ServerFacts): boolean {
  return (server.os === 'darwin' || server.os === 'win32') && !runsInAppSandbox(server)
}

/**
 * Whether the server runs the scripts agents ask for on its machine, of the
 * types `VALID_SCRIPT_TYPES` lists for its OS. A script a sandboxed app runs is
 * confined to the app's container and may not script other apps.
 */
export function runsHostScripts(server: ServerFacts): boolean {
  return !runsInAppSandbox(server)
}

/**
 * Whether the server can use the person's installed Chrome: launch it with a
 * debugging port as the agents' browser, copy a profile's logins into the
 * built-in browser, and read Apple Passwords through Chrome's extension. A
 * sandboxed app can't: macOS strips the arguments of an app it opens, Chrome
 * aborts when started inside the sandbox, and Chrome's profiles are outside the
 * app's container. Agents there browse in their built-in browser.
 */
export function drivesUserChrome(server: ServerFacts): boolean {
  return !runsInAppSandbox(server)
}

/**
 * Whether the server reads a folder of its machine by its path alone: one it
 * is told to copy in, or to make a drive of. A sandboxed app reaches only its
 * container, plus a folder the person picked in its open panel, through the
 * security-scoped bookmark the pick makes (`local-folder-access.ts`). So there
 * a local drive needs that bookmark, and a dropped folder uploads its files.
 */
export function readsHostFolders(server: ServerFacts): boolean {
  return !runsInAppSandbox(server)
}

/**
 * Whether the server runs git and gh on its machine: to clone a private
 * skillset, and to publish skills and agents to one as commits and pull
 * requests. Public skillsets need neither; they download as an archive. A
 * sandboxed app can run neither: macOS's own git is a stub that installs the
 * developer tools, and gh lives outside the app.
 */
export function runsHostGit(server: ServerFacts): boolean {
  return !runsInAppSandbox(server)
}

/**
 * Whether this install runs in the App Sandbox, as the Mac App Store build
 * does. Either half can be asked: in the desktop app they are the same install.
 *
 * The sandbox decides how the app is laid out, not only what it offers:
 * - its home is its container, whose root Virtualization.framework refuses to
 *   share with a VM, and whose long path leaves little room under the 104-byte
 *   limit for Lima's sockets;
 * - it can signal only the processes of its own launch, so it can't tell
 *   whether an earlier launch left something running.
 *
 * What it withholds from agents has a capability each here, and the desktop
 * app's own Mac integrations ask theirs in `renderer/lib/capabilities.ts`.
 * Settings lists all of it for the person (`SandboxNotice`), and the agents'
 * prompt the agents' part (`appSandbox`); a new one goes in both.
 */
export function runsInAppSandbox(facts: { distribution: ServerDistribution | DesktopDistribution | null }): boolean {
  return facts.distribution === 'mac-app-store'
}

/**
 * Whether the server offers a container runtime. A sandboxed build can't run
 * the docker, podman or container CLIs the other runtimes drive, so it offers
 * only the runtime it bundles. Each distribution is listed, so a new one (a
 * sandboxed Windows Store build, say) has to say which runtimes it offers.
 */
export function offersRuntime(server: ServerFacts, runner: string): boolean {
  switch (server.distribution) {
    // The App Sandbox: only the Lima the bundle ships.
    case 'mac-app-store':
      return runner === 'lima'
    // Today's Windows Store build is a full-trust package, not sandboxed.
    case 'windows-store':
    case 'direct':
    case 'deployment':
      return true
  }
}

/**
 * Whether the server may download code it runs, such as a VM image or
 * packages from a CDN. The Mac App Store build ships all of it in the bundle
 * (App Review guideline 2.5.2).
 */
export function mayDownloadCode(server: ServerFacts): boolean {
  return server.distribution !== 'mac-app-store'
}

/** Whether the desktop app updates itself. A Store delivers the updates of the builds it distributes. */
export function updatesItself(client: ClientFacts): boolean {
  return client.shell === 'electron' && client.distribution === 'direct'
}
