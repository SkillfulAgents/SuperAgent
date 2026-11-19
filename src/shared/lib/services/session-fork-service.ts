/**
 * Fork a session: copy the conversation into a new idle chat.
 *
 * Lives next to register/delete rather than in the route so the rollback
 * (register fails → host delete + container delete) is one call. Kept out of
 * session-service.ts because this path talks to the container and the live
 * sessions through the agent's actor, and session-service is already in that
 * import graph.
 */

import { sql } from 'drizzle-orm'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { AgentActor } from '@shared/lib/agent-actor'
import { ContainerNotFoundError } from '@shared/lib/container/types'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import type { SessionInfo, SessionMetadata } from '@shared/lib/types/agent'
import { hasIntegrationMessages } from '@shared/lib/services/agent-integration-message-service'
import { SessionForkFailedError } from '@shared/lib/agent-runtime-errors/session-fork-failed/session-fork-failed-error'

export type ForkSessionOpts = {
  createdByUserId?: string
  createdByDeviceId?: string
  copyAttribution?: boolean
}

export type ForkedSession = SessionInfo & {
  isActive: false
  forkedFromSessionId: string
  forkedFromSessionName: string
  model?: string
  effort?: SessionMetadata['effort']
  speed?: SessionMetadata['speed']
}

function runtimeChoices(metadata: SessionMetadata | null | undefined): Pick<
  SessionMetadata,
  'model' | 'llmProviderId' | 'effort' | 'speed'
> {
  return {
    ...(metadata?.llmProviderId ? { llmProviderId: metadata.llmProviderId } : {}),
    ...(metadata?.model ? { model: metadata.model } : {}),
    ...(metadata?.effort ? { effort: metadata.effort } : {}),
    ...(metadata?.speed ? { speed: metadata.speed } : {}),
  }
}

export async function forkSession(
  slug: string,
  sourceId: string,
  opts: ForkSessionOpts = {},
): Promise<ForkedSession> {
  const actor = agentRegistry.get(slug)

  const [known, metadataMap] = await Promise.all([
    actor.sessions.isKnown(sourceId),
    actor.sessions.readMetadata(),
  ])
  const metadata = Object.hasOwn(metadataMap, sourceId) ? metadataMap[sourceId] : null
  if (!known) {
    throw new SessionForkFailedError(404, 'Session not found')
  }

  const [source] = await Promise.all([
    actor.sessions.get(sourceId, { metadata }),
    actor.container.start(),
  ])
  if (!source) {
    throw new SessionForkFailedError(404, 'Session not found')
  }

  let forked: { id: string } | null
  try {
    forked = await actor.sessions.fork(sourceId)
  } catch (error) {
    if (error instanceof ContainerNotFoundError) {
      throw new SessionForkFailedError(404, error.message)
    }
    throw error
  }
  if (!forked) {
    throw new SessionForkFailedError(
      500,
      'Container does not support fork; restart the agent to pull the latest image',
    )
  }

  const newId = forked.id
  const name = `${source.name} (fork)`
  const choices = runtimeChoices(metadata)
  const initialMetadata: Partial<SessionMetadata> = {
    forkedFromSessionId: sourceId,
    ...choices,
    ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    ...(opts.createdByDeviceId ? { createdByDeviceId: opts.createdByDeviceId } : {}),
  }

  try {
    await actor.sessions.register(newId, name, initialMetadata)
  } catch (error) {
    try {
      await actor.sessions.delete(newId)
    } catch (cleanupError) {
      console.error(`fork: host delete of ${newId} failed`, cleanupError)
    } finally {
      await actor.sessions.deleteLive(newId).catch(console.error)
    }
    throw error
  }

  await Promise.all([
    actor.sessions.copyDerivedFiles(sourceId, newId).catch((error) => {
      console.error(`fork: subagent/workflow copy for ${newId} failed (non-fatal)`, error)
    }),
    copyForkAttribution(actor, sourceId, newId, { authors: !!opts.copyAttribution }).catch((error) => {
      console.error(`fork: attribution copy for ${newId} failed (non-fatal)`, error)
    }),
  ])

  return {
    id: newId,
    agentSlug: slug,
    name,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    isActive: false,
    forkedFromSessionId: sourceId,
    forkedFromSessionName: source.name,
    ...choices,
  }
}

/**
 * Copy only this recipient's source rows. A queued prompt can keep its ID in
 * both sessions. An integration delivery ID is globally unique for retries,
 * so a queued integration card stays with its original delivery.
 */
async function copyForkAttribution(actor: AgentActor, sourceId: string, newId: string, opts: { authors: boolean }): Promise<void> {
  const slug = actor.slug
  if (!opts.authors && !(await hasIntegrationMessages(slug, sourceId))) return
  const pairs = await actor.messages.forkedUserUuids(newId)
  if (pairs.length === 0) return

  await db.run(sql`
    INSERT INTO ${messageAuthor} (agent_slug, session_id, id, user_id, author_agent_slug, billed_user_id, integration_id, display, created_at)
    SELECT source.agent_slug, ${newId}, json_extract(pair.value, '$.newUuid'),
           source.user_id, source.author_agent_slug, source.billed_user_id, source.integration_id, source.display, source.created_at
    FROM json_each(${JSON.stringify(pairs)}) AS pair
    JOIN ${messageAuthor} AS source ON source.id = json_extract(pair.value, '$.oldUuid')
    WHERE source.agent_slug = ${slug} AND source.session_id = ${sourceId}
    ON CONFLICT DO NOTHING
  `)
}
