import { randomUUID } from 'node:crypto'
import type { AgentActor } from '@shared/lib/agent-actor'
import type { SessionMetadata } from '@shared/lib/types/agent'

type Receipt = NonNullable<SessionMetadata['creationSetup']>
type Start = (initialMessageUuid: string, receipt?: Receipt) => Promise<{ id: string }>

/** The session index records acceptance in the same operation that starts the turn. */
export async function startWithCreationSetup(
  actor: AgentActor,
  options: { userId: string; requestId?: string },
  start: Start,
) {
  const initialMessageUuid = randomUUID()
  if (!options.requestId) {
    const { id } = await start(initialMessageUuid)
    return { id, initialMessageUuid, replayed: false }
  }

  const lock = await actor.locks.acquire('creation:first-session')
  try {
    const sessions = Object.entries(await actor.sessions.readMetadata())
    for (const [id, { creationSetup }] of sessions) {
      if (creationSetup?.requestId === options.requestId && creationSetup.userId === options.userId) {
        return { id, initialMessageUuid: creationSetup.initialMessageUuid, replayed: true }
      }
    }
    const { id } = await start(initialMessageUuid, { userId: options.userId, requestId: options.requestId, initialMessageUuid })
    return { id, initialMessageUuid, replayed: false }
  } finally {
    await actor.locks.release('creation:first-session', lock)
  }
}
