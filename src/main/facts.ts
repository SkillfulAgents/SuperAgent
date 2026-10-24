import type { ApiTarget } from '@shared/lib/api-target'
import { serverFactsSchema, type Facts, type ServerFacts } from '@shared/lib/facts/facts-schema'
import { currentOs, desktopDistribution, getServerFacts } from '@shared/lib/facts/server-facts'
import type { CloudEndpoint } from './api-target'

/**
 * The facts a renderer gates on, for the target it settled (see
 * `docs/facts.md`). The client half is always this install. The server half is
 * this install too when the renderer drives the local API, which main hosts;
 * for a cloud workspace it is the deployment's, which only the deployment knows.
 */

/**
 * Boot waits on this, so it is short. Running out means the renderer starts
 * without the server's facts, which capabilities read as "not offered", not as
 * a failed boot.
 */
const CLOUD_FACTS_TIMEOUT_MS = 3_000

/**
 * Per deployment, for the life of the process: a deployment's facts change only
 * when it is redeployed, and every renderer boot (each window, each reload) asks
 * again. A failure is not kept, so the next boot tries again.
 */
const cloudFacts = new Map<string, Promise<ServerFacts | null>>()

export async function factsForRenderer(target: ApiTarget, cloud: CloudEndpoint | null): Promise<Facts> {
  const client = { shell: 'electron', os: currentOs(), distribution: desktopDistribution() } as const
  if (target === 'local') return { client, server: getServerFacts() }
  return { client, server: cloud ? await cloudServerFacts(cloud) : null }
}

function cloudServerFacts(cloud: CloudEndpoint): Promise<ServerFacts | null> {
  const known = cloudFacts.get(cloud.deploymentUrl)
  if (known) return known
  const pending = fetchServerFacts(cloud.baseUrl).then((facts) => {
    if (!facts) cloudFacts.delete(cloud.deploymentUrl)
    return facts
  })
  cloudFacts.set(cloud.deploymentUrl, pending)
  return pending
}

/**
 * Through the cloud proxy rather than to the deployment directly, so the
 * request gets the proxy's credential and token refresh like any other.
 * A deployment older than `GET /api/server-facts` answers 404, which is null.
 */
async function fetchServerFacts(proxyBaseUrl: string): Promise<ServerFacts | null> {
  try {
    const response = await fetch(`${proxyBaseUrl}/api/server-facts`, {
      signal: AbortSignal.timeout(CLOUD_FACTS_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined)
      return null
    }
    const parsed = serverFactsSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Test seam: forgets every deployment's facts. */
export function _resetCloudFactsForTest(): void {
  cloudFacts.clear()
}
