import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { platformAgentKeys } from '@shared/lib/db/schema'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { agentCatalog } from '@shared/lib/agent-actor/agent-catalog'
import { serializeByKey } from '@shared/lib/utils/keyed-queue'
import { attribution, runOutsideAttribution } from './index'
import { getPlatformAppKey, revokePlatformTokenRemotely } from '../services/platform-auth-service'
import { captureMessage } from '../error-reporting'

/** The app's own platform bearer for an agent's acting member. It never enters a container. */
async function getPlatformAppToken(agentId: string): Promise<string | undefined> {
  const token = getPlatformAppKey()
  if (!token) return undefined

  // A container is shared by sessions. Without an ambient request (scheduler,
  // recovery), resolve the agent owner before falling back to the org token.
  const auth = await attribution.forAgent(agentId)
  if (auth) return auth.bearerToken()
  // Every agent key belongs to one member, so a bare org token cannot mint one.
  if (attribution.requiresActingMember()) {
    console.warn(`[Platform] No acting member resolved for agent ${agentId}; container gets no platform key`)
    captureMessage('platform container env built without acting member', {
      level: 'warning',
      tags: { area: 'platform-attribution', op: 'container.env.no_member' },
      extra: { agentId },
    })
    return undefined
  }
  return token
}

const mintResponse = z.object({ key: z.string().startsWith('plat_ag_') })

// Acquiring and revoking an agent's keys run one at a time per agent: a second
// mint would revoke the first, and a revoke must see every key a request
// already in flight could still mint.
const withAgentLock = <T>(agentId: string, fn: () => Promise<T>) => serializeByKey(`platform-agent-key:${agentId}`, fn)

/**
 * The agent's limited platform key, shared by Platform inference and services.
 * Undefined when there is no app key or minting fails: the container then gets
 * no platform key at all.
 */
export async function getPlatformContainerToken(agentId?: string): Promise<string | undefined> {
  if (!agentId) return undefined
  return withAgentLock(agentId, async () => {
    const appToken = await getPlatformAppToken(agentId)
    if (!appToken) return undefined

    const parentHash = createHash('sha256').update(appToken).digest('hex')
    const [stored] = await db
      .select({ key: platformAgentKeys.key })
      .from(platformAgentKeys)
      .where(and(eq(platformAgentKeys.agentSlug, agentId), eq(platformAgentKeys.parentHash, parentHash)))
      .limit(1)
    if (stored) return stored.key

    if (!(await agentCatalog.exists(agentId))) return undefined
    return mintAgentKey(agentId, appToken, parentHash)
  })
}

async function mintAgentKey(agentId: string, appToken: string, parentHash: string): Promise<string | undefined> {
  // The fetch interceptor would replace this bearer with the ambient one.
  const res = await runOutsideAttribution(() =>
    fetch(`${getPlatformProxyBaseUrl()}/v1/agent-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
      signal: AbortSignal.timeout(10_000),
    }),
  ).catch(() => null)
  const parsed = res?.ok ? mintResponse.safeParse(await res.json().catch(() => null)) : null
  if (!parsed?.success) return reportMintFailure(agentId, { status: res?.status ?? null })
  const stored = await db
    .insert(platformAgentKeys)
    .values({ agentSlug: agentId, parentHash, key: parsed.data.key, createdAt: new Date() })
    .then(() => true, () => false)
  if (!stored) return reportMintFailure(agentId, { status: res?.status ?? null, stored: false })
  return parsed.data.key
}

function reportMintFailure(agentId: string, extra: Record<string, unknown>): undefined {
  captureMessage('platform agent key mint failed', {
    level: 'warning',
    tags: { area: 'platform-attribution', op: 'agent_key.mint' },
    extra: { agentId, ...extra },
  })
  return undefined
}

/** Revokes every platform key minted for the agent. Call once the agent is deleted. */
export async function revokePlatformAgentKey(agentId: string): Promise<void> {
  await withAgentLock(agentId, async () => {
    const rows = await db
      .select({ key: platformAgentKeys.key })
      .from(platformAgentKeys)
      .where(eq(platformAgentKeys.agentSlug, agentId))
    const revoked = await Promise.all(rows.map(({ key }) => runOutsideAttribution(() => revokePlatformTokenRemotely(key))))
    await db.delete(platformAgentKeys).where(eq(platformAgentKeys.agentSlug, agentId))
    const failed = revoked.filter(ok => !ok).length
    if (failed) {
      captureMessage('platform agent key revoke failed', {
        level: 'warning',
        tags: { area: 'platform-attribution', op: 'agent_key.revoke' },
        extra: { agentId, failed },
      })
    }
  })
}
