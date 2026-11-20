import type { ClientFacts, DesktopDistribution, Os, ServerCapabilities, ServerDistribution, ServerFacts } from './facts-schema'

/**
 * What each runtime declares its machine does for agents. A process reads its
 * own answer with `getServerCapabilities()`; a renderer reads the same object
 * from the facts the server sent (`renderer/lib/capabilities.ts`), so the two
 * can't disagree. A runtime this table can't tell apart by its facts (a host
 * that keeps nothing past a request) declares its own at boot
 * (`declareServerCapabilities()`).
 *
 * Each distribution is listed, so a new one has to say what it offers.
 */
export function runtimeCapabilities(server: Pick<ServerFacts, 'os' | 'distribution'>): ServerCapabilities {
  switch (server.distribution) {
    case 'direct':
    case 'windows-store':
      return desktopCapabilities(server.os)
    // The App Sandbox confines the app to its container. It may not control
    // other apps or script them; macOS strips the arguments of an app it opens
    // and Chrome aborts inside the sandbox; it reaches a folder only through
    // the bookmark of a pick in its open panel (`local-folder-access.ts`);
    // macOS's own git is a stub that installs the developer tools, and gh lives
    // outside the app.
    case 'mac-app-store':
      return NOTHING_ON_THE_HOST
    // A web deployment's machine is not the person's computer, so what acts on
    // the person's desktop is off. What acts on the server's own machine stays:
    // git for private skillsets, and looking for an installed Ollama.
    case 'deployment':
      return { ...NOTHING_ON_THE_HOST, canFindHostApps: true, canRunHostGit: true }
  }
}

/** The desktop app outside the sandbox. There is a computer-use backend, and a script tool, for macOS and Windows only. */
function desktopCapabilities(os: Os): ServerCapabilities {
  const desktopOs = os === 'darwin' || os === 'win32'
  return {
    canUseComputer: desktopOs,
    canRunHostScripts: desktopOs,
    canDriveUserChrome: true,
    canReadHostFoldersByPath: true,
    canFindHostApps: true,
    canRunHostGit: true,
  }
}

const NOTHING_ON_THE_HOST: ServerCapabilities = {
  canUseComputer: false,
  canRunHostScripts: false,
  canDriveUserChrome: false,
  canReadHostFoldersByPath: false,
  canFindHostApps: false,
  canRunHostGit: false,
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
 * What it withholds from agents is its row in `runtimeCapabilities()`, and the
 * desktop app's own Mac integrations ask theirs in `renderer/lib/capabilities.ts`.
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
