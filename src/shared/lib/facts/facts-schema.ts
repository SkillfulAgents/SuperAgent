import { z } from 'zod'

/**
 * Facts about where this app runs, in two halves, because the window and the
 * agents are not always on the same computer:
 *
 * - **Client:** the app the person is looking at, and the computer it runs on.
 * - **Server:** the machine that runs the API and the agents.
 *
 * The desktop app driving its own API has both halves on one computer, and they
 * agree by construction. The desktop app driving a cloud workspace has its
 * client on this laptop and its server somewhere else. A web deployment has one
 * server and many browsers, so server code can never know "the" client: it
 * reads server facts only.
 *
 * Call sites ask a capability (`capabilities.ts` here, or
 * `renderer/lib/capabilities.ts`), not these: a capability says which half it
 * asks about, and adding a new kind of build means editing those files rather
 * than every gate. Reading one fact to choose *how* to do something (which setup
 * steps to show) is fine; combining facts to decide *whether* a feature exists
 * belongs in a capability. See `docs/facts.md`.
 */

export const osSchema = z.enum(['darwin', 'win32', 'linux', 'other'])
export type Os = z.infer<typeof osSchema>

/** Narrow a Node platform name (`process.platform`) to the OSes the app tells apart. */
export function osOf(platform: string): Os {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other'
}

/**
 * How a desktop install reached this computer. Electron decides it: it sets
 * `process.mas` in `mas` and `mas-dev` builds and `process.windowsStore` in an
 * AppX/MSIX build.
 */
export const desktopDistributionSchema = z.enum(['direct', 'mac-app-store', 'windows-store'])
export type DesktopDistribution = z.infer<typeof desktopDistributionSchema>

/** A server is a desktop install's own API, or a web deployment. */
export const serverDistributionSchema = z.enum([...desktopDistributionSchema.options, 'deployment'])
export type ServerDistribution = z.infer<typeof serverDistributionSchema>

/**
 * Sent to renderers: inlined into the web build's HTML, and fetched by the
 * desktop app from a cloud workspace (`GET /api/server-facts`). Both are public,
 * since the login page is the same HTML, so only facts safe for an anonymous
 * visitor belong here.
 *
 * Unknown keys are dropped rather than refused, so a newer server's extra facts
 * don't cost an older client the ones it understands.
 */
export const serverFactsSchema = z.object({
  os: osSchema,
  distribution: serverDistributionSchema,
})
export type ServerFacts = z.infer<typeof serverFactsSchema>

/**
 * A cloud workspace's facts as the desktop app last heard them, kept in
 * settings so a renderer driving it has them at boot without a request
 * (`cloud-server-facts.ts`).
 */
export const cloudServerFactsRecordSchema = z.object({
  deploymentUrl: z.string(),
  facts: serverFactsSchema,
})
export type CloudServerFactsRecord = z.infer<typeof cloudServerFactsRecordSchema>

export interface ClientFacts {
  shell: 'electron' | 'browser'
  /**
   * Null in a browser. A page can't know its OS reliably, and a guess from the
   * user agent is a wrong answer that would be trusted.
   */
  os: Os | null
  /** Null in a browser. */
  distribution: DesktopDistribution | null
}

/**
 * Both halves, as a renderer holds them. `server` is null when the server
 * didn't say: a cloud workspace older than `GET /api/server-facts`, or one the
 * desktop app hasn't heard from yet.
 */
export interface Facts {
  client: ClientFacts
  server: ServerFacts | null
}

/** Id of the `<script type="application/json">` block that carries a web server's facts in its HTML. */
export const SERVER_FACTS_ELEMENT_ID = 'server-facts'

/**
 * Left by the build in the service worker's revision of the HTML entry, for the
 * web server to replace with its facts (`withServerFactsRevision()`).
 */
export const SERVER_FACTS_REVISION_PLACEHOLDER = '__SERVER_FACTS__'
