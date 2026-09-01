/**
 * Fork a session: copy the conversation into a new idle chat.
 *
 * Lives next to register/delete rather than in the route so the rollback
 * (register fails → host delete + container delete) is one call. Kept out of
 * session-service.ts because this path talks to the container and the
 * persister, and session-service is already in that import graph.
 */

import * as path from 'path'
import { and, eq, inArray } from 'drizzle-orm'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { ContainerConflictError, ContainerNotFoundError } from '@shared/lib/container/types'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import type { SessionInfo, SessionMetadata } from '@shared/lib/types/agent'
import {
  copyDirectoryFiltered,
  getAgentSessionsDir,
  getSessionJsonlPath,
  streamJsonlFile,
} from '@shared/lib/utils/file-storage'
import { insertMessageAuthorsBestEffort } from '@/api/routes/message-author'
import { forkedUserLineSchema } from '@/api/routes/fork-attribution-schema'
import {
  deleteSession,
  getSession,
  registerSession,
  readSessionMetadata,
  sessionIsKnown,
} from './session-service'

export class ForkSessionError extends Error {
  constructor(
    readonly status: 404 | 409 | 500,
    message: string,
  ) {
    super(message)
    this.name = 'ForkSessionError'
  }
}

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
  'model' | 'effort' | 'speed'
> {
  return {
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
  if (messagePersister.isSessionActive(slug, sourceId)) {
    throw new ForkSessionError(409, 'Session is currently running')
  }

  const [known, metadataMap] = await Promise.all([
    sessionIsKnown(slug, sourceId),
    readSessionMetadata(slug),
  ])
  const metadata = Object.hasOwn(metadataMap, sourceId) ? metadataMap[sourceId] : null
  if (!known) {
    throw new ForkSessionError(404, 'Session not found')
  }

  const [source] = await Promise.all([
    getSession(slug, sourceId, { metadata }),
    containerManager.ensureRunning(slug),
  ])
  if (!source) {
    throw new ForkSessionError(404, 'Session not found')
  }
  const client = containerManager.getClient(slug)

  let forked: { id: string } | null
  try {
    forked = await client.forkSession(sourceId)
  } catch (error) {
    if (error instanceof ContainerConflictError) {
      throw new ForkSessionError(409, error.message)
    }
    if (error instanceof ContainerNotFoundError) {
      throw new ForkSessionError(404, error.message)
    }
    throw error
  }
  if (!forked) {
    throw new ForkSessionError(
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
    ...(metadata?.slashCommands ? { slashCommands: metadata.slashCommands } : {}),
    ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    ...(opts.createdByDeviceId ? { createdByDeviceId: opts.createdByDeviceId } : {}),
  }

  try {
    await registerSession(slug, newId, name, initialMetadata)
  } catch (error) {
    try {
      await deleteSession(slug, newId)
    } catch (cleanupError) {
      console.error(`fork: host delete of ${newId} failed`, cleanupError)
    } finally {
      await client.deleteSession(newId).catch(console.error)
    }
    throw error
  }

  const sessionsDir = getAgentSessionsDir(slug)
  await Promise.all([
    copyDirectoryFiltered(path.join(sessionsDir, sourceId), path.join(sessionsDir, newId)).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        console.error(`fork: subagent/workflow copy for ${newId} failed (non-fatal)`, error)
      },
    ),
    opts.copyAttribution
      ? copyForkAttribution(slug, sourceId, newId).catch((error) => {
          console.error(`fork: attribution copy for ${newId} failed (non-fatal)`, error)
        })
      : Promise.resolve(),
  ])

  return {
    id: newId,
    agentSlug: slug,
    name,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    messageCount: source.messageCount,
    isActive: false,
    forkedFromSessionId: sourceId,
    forkedFromSessionName: source.name,
    ...choices,
  }
}

/**
 * Auth mode: the SDK fork remaps every message uuid and stamps
 * `forkedFrom.messageUuid` (the old uuid) on each line. Attribution rows are
 * keyed by uuid, so re-key the source's rows onto the fork's user messages.
 */
async function copyForkAttribution(slug: string, sourceId: string, newId: string): Promise<void> {
  const pairs: { newUuid: string; oldUuid: string }[] = []
  for await (const raw of streamJsonlFile(getSessionJsonlPath(slug, newId))) {
    const parsed = forkedUserLineSchema.safeParse(raw)
    if (parsed.success) pairs.push({ newUuid: parsed.data.uuid, oldUuid: parsed.data.forkedFrom.messageUuid })
  }
  if (pairs.length === 0) return

  const rows = await db
    .select({ id: messageAuthor.id, userId: messageAuthor.userId })
    .from(messageAuthor)
    .where(and(eq(messageAuthor.sessionId, sourceId), inArray(messageAuthor.id, pairs.map((p) => p.oldUuid))))
  const userByOld = new Map(rows.map((r) => [r.id, r.userId]))
  await insertMessageAuthorsBestEffort(
    pairs.flatMap(({ newUuid, oldUuid }) => {
      const userId = userByOld.get(oldUuid)
      return userId ? [{ id: newUuid, sessionId: newId, agentSlug: slug, userId }] : []
    }),
  )
}
