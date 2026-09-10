import { db } from '@shared/lib/db'
import {
  agentConnectedAccounts,
  agentRemoteMcps,
  connectedAccounts,
  remoteMcpServers,
} from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from './container-manager'
import {
  buildConnectedAccountsProjection,
  buildRemoteMcpProjection,
} from './connection-runtime-projections'

type RuntimeClient = Pick<
  ReturnType<typeof containerManager.getClient>,
  'fetch' | 'getHostApiBaseUrl'
>

export type ConnectionRuntimeKind = 'connected-accounts' | 'remote-mcps'

export async function updateConnectedAccountsEnvironment(
  agentSlug: string,
  client: RuntimeClient,
): Promise<Response> {
  const mappings = await db
    .select({ account: connectedAccounts })
    .from(agentConnectedAccounts)
    .innerJoin(
      connectedAccounts,
      eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id),
    )
    .where(eq(agentConnectedAccounts.agentSlug, agentSlug))

  const metadata = buildConnectedAccountsProjection(
    mappings.map(({ account }) => account),
  )

  return client.fetch('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'CONNECTED_ACCOUNTS',
      value: JSON.stringify(metadata),
    }),
  })
}

export async function updateRemoteMcpEnvironment(
  agentSlug: string,
  client: RuntimeClient,
): Promise<Response> {
  const hostApiBaseUrl = await client.getHostApiBaseUrl()
  const mappings = await db
    .select({ mcp: remoteMcpServers })
    .from(agentRemoteMcps)
    .innerJoin(
      remoteMcpServers,
      eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id),
    )
    .where(eq(agentRemoteMcps.agentSlug, agentSlug))

  const configs = buildRemoteMcpProjection(
    mappings.map(({ mcp }) => mcp),
    agentSlug,
    hostApiBaseUrl,
  )

  return client.fetch('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'REMOTE_MCPS',
      value: JSON.stringify(configs),
    }),
  })
}

export async function syncAgentConnectionEnvironment(
  agentSlug: string,
  kind: ConnectionRuntimeKind,
): Promise<boolean> {
  if (containerManager.getCachedInfo(agentSlug).status !== 'running') {
    // Container startup rebuilds both projections from the mapping tables.
    return true
  }

  try {
    const client = containerManager.getClient(agentSlug)
    const response = kind === 'remote-mcps'
      ? await updateRemoteMcpEnvironment(agentSlug, client)
      : await updateConnectedAccountsEnvironment(agentSlug, client)

    if (!response.ok) {
      console.warn(
        `[ConnectionRuntimeSync] Failed to update ${kind} for ${agentSlug}:`,
        await response.text(),
      )
    }
    return response.ok
  } catch (error) {
    console.warn(
      `[ConnectionRuntimeSync] Failed to sync ${kind} for ${agentSlug}:`,
      error,
    )
    return false
  }
}

// Fanning a sync out over several agents lives in
// `@shared/lib/services/connection-sync-service`, which goes through the agent
// actor for each one. This module only knows how to build and push one agent's
// projection.
