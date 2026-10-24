import type { ServerFacts } from './facts-schema'

/**
 * What a server can do, as pure functions of its facts. The server asks them of
 * `getServerFacts()`; a renderer asks the same function of the facts of the
 * server it drives (`renderer/lib/capabilities.ts`), so the two can't disagree.
 */

/** Computer use drives the desktop of the agents' machine, and has a backend for macOS and Windows only. */
export function supportsComputerUse(server: ServerFacts): boolean {
  return server.os === 'darwin' || server.os === 'win32'
}
