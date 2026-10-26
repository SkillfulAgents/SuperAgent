import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { cloudServerFactsRecordSchema, serverFactsSchema, type ServerFacts } from '@shared/lib/facts/facts-schema'

/**
 * The cloud workspace's server facts, as the desktop app last heard them.
 *
 * A renderer driving the workspace needs them before its first render, and
 * nothing may wait on the network for that: boot already waits on the
 * deployment for the session and settings. So main never asks at boot. It
 * answers from this record, which the workspace's maintenance cycle keeps
 * current in the background (`refreshCloudWorkspace()`: on start, on connect,
 * and every half hour).
 *
 * A record is a last answer, not a live one. A redeploy that changes the facts
 * reaches the next boot after the next cycle, which is why only facts that
 * change with a deploy belong in `ServerFacts` (`docs/facts.md`).
 */

/** Nobody waits on the refresh, so it can take its time; it only must not hang forever. */
const REFRESH_TIMEOUT_MS = 10_000

function normalize(deploymentUrl: string): string {
  return deploymentUrl.replace(/\/+$/, '')
}

/** The facts last heard from this deployment, or null when it never said. */
export function readCloudServerFacts(deploymentUrl: string): ServerFacts | null {
  const parsed = cloudServerFactsRecordSchema.safeParse(getSettings().cloudServerFacts)
  if (!parsed.success || parsed.data.deploymentUrl !== normalize(deploymentUrl)) return null
  return parsed.data.facts
}

/**
 * Ask the deployment for its facts and keep them. Never throws: a failure keeps
 * the last answer, since a deployment that couldn't be reached hasn't changed.
 *
 * Unauthenticated, like the endpoint: the facts are what any visitor's HTML
 * carries.
 */
export async function refreshCloudServerFacts(deploymentUrl: string): Promise<void> {
  const url = normalize(deploymentUrl)
  const facts = await fetchServerFacts(url)
  if (!facts) return
  const record = cloudServerFactsRecordSchema.parse({ deploymentUrl: url, facts })
  if (JSON.stringify(getSettings().cloudServerFacts) === JSON.stringify(record)) return
  mutateSettings((settings) => {
    settings.cloudServerFacts = record
  })
}

async function fetchServerFacts(deploymentUrl: string): Promise<ServerFacts | null> {
  try {
    const response = await fetch(`${deploymentUrl}/api/server-facts`, {
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })
    if (!response.ok) {
      // A deployment older than the endpoint answers 404.
      await response.arrayBuffer().catch(() => undefined)
      return null
    }
    const parsed = serverFactsSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
