import type { ClientFacts, DesktopDistribution, ServerDistribution, ServerFacts } from './facts-schema'

/**
 * What an install can do, as pure functions of its facts. The server asks the
 * server ones of `getServerFacts()`; a renderer asks the same function of the
 * facts of the server it drives (`renderer/lib/capabilities.ts`), so the two
 * can't disagree.
 */

/** Computer use drives the desktop of the agents' machine, and has a backend for macOS and Windows only. */
export function supportsComputerUse(server: ServerFacts): boolean {
  return server.os === 'darwin' || server.os === 'win32'
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
 */
export function runsInAppSandbox(facts: { distribution: ServerDistribution | DesktopDistribution | null }): boolean {
  return facts.distribution === 'mac-app-store'
}

/**
 * Whether the server offers a container runtime. In the App Sandbox, only the
 * bundled Lima: the sandbox can't run the docker, podman or container CLIs
 * the other runtimes drive.
 */
export function offersRuntime(server: ServerFacts, runner: string): boolean {
  return !runsInAppSandbox(server) || runner === 'lima'
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
