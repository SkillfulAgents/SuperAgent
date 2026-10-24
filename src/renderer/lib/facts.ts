import {
  SERVER_FACTS_ELEMENT_ID,
  osOf,
  serverFactsSchema,
  type ClientFacts,
  type Facts,
  type ServerFacts,
} from '@shared/lib/facts/facts-schema'
import type { ApiTarget } from '@shared/lib/api-target'

/**
 * The facts this renderer gates on: the client half (this window's app and
 * computer) and the server half (the machine running the API it drives). See
 * `@shared/lib/facts/facts-schema.ts` for why there are two, and
 * `capabilities.ts` for the questions call sites ask of them.
 *
 * Settled once by `initApiBaseUrl()`, before the first render, with no request
 * of its own:
 * - **Web:** the server inlines its facts into the HTML it serves.
 * - **Electron:** main hands them over with the target. For the local API, main
 *   *is* the server; for a cloud workspace, main asked the deployment.
 *
 * Frozen for the renderer's lifetime, like the target they belong to: switching
 * targets reloads the window.
 */

let settled: Facts | null = null

const BROWSER: ClientFacts = { shell: 'browser', os: null, distribution: null }

/** Called once by `initApiBaseUrl()`. Never throws: a renderer without facts is one whose capabilities are off. */
export async function initFacts(target: ApiTarget): Promise<void> {
  settled = await readFacts(target)
}

async function readFacts(target: ApiTarget): Promise<Facts> {
  const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!electronAPI) return { client: BROWSER, server: readInlinedServerFacts() }
  // A missing handler is an older main process (see env.ts).
  const facts = await electronAPI.getFacts?.(target).catch(() => null)
  return facts ?? { client: { shell: 'electron', os: osOf(electronAPI.platform), distribution: null }, server: null }
}

/** What the web server inlined. An HTML entry precached before facts existed has none. */
function readInlinedServerFacts(): ServerFacts | null {
  const text = typeof document !== 'undefined' ? document.getElementById(SERVER_FACTS_ELEMENT_ID)?.textContent : null
  if (!text) return null
  try {
    const parsed = serverFactsSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function read(): Facts {
  if (!settled) throw new Error('Facts read before initApiBaseUrl() settled them')
  return settled
}

/** This window's app and the computer it runs on. */
export function clientFacts(): ClientFacts {
  return read().client
}

/** The machine running the API this renderer drives, or null when it didn't say. */
export function serverFacts(): ServerFacts | null {
  return read().server
}

/** Test seam: settles the facts directly, as boot would. */
export function _setFactsForTest(facts: Facts): void {
  settled = facts
}

/** Test seam: returns the module to its pre-boot state. */
export function _resetFactsForTest(): void {
  settled = null
}
