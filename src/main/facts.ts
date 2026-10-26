import type { ApiTarget } from '@shared/lib/api-target'
import type { ClientFacts, Facts } from '@shared/lib/facts/facts-schema'
import { currentOs, desktopDistribution, getServerFacts } from '@shared/lib/facts/server-facts'
import { readCloudServerFacts } from '@shared/lib/services/cloud-server-facts'
import type { CloudEndpoint } from './api-target'

/**
 * The facts a renderer gates on, for the target it settled (see
 * `docs/facts.md`). The client half is always this install. The server half is
 * this install too when the renderer drives the local API, which main hosts;
 * for a cloud workspace it is the deployment's, as main last heard them.
 *
 * Every renderer boot waits on this, so it never touches the network: the
 * workspace's maintenance cycle fetches the deployment's facts in the
 * background, and this reads what it kept (`cloud-server-facts.ts`).
 */

/** This install as a client: what main asks for its own desktop features, such as updates. */
export function desktopClientFacts(): ClientFacts {
  return { shell: 'electron', os: currentOs(), distribution: desktopDistribution() }
}

export function factsForRenderer(target: ApiTarget, cloud: CloudEndpoint | null): Facts {
  const client = desktopClientFacts()
  if (target === 'local') return { client, server: getServerFacts() }
  return { client, server: cloud ? readCloudServerFacts(cloud.deploymentUrl) : null }
}
