import { randomUUID } from 'node:crypto'
import { updateConfigDoc, type AgentActor } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import type { SessionMetadata } from '@shared/lib/types/agent'

type Receipt = NonNullable<SessionMetadata['creationSetup']>
type Start = (initialMessageUuid: string, receipt?: Receipt) => Promise<{ id: string }>

/** The session index records acceptance in the same operation that starts the turn. */
export async function startWithCreationSetup(
  actor: AgentActor,
  options: { userId: string; requestId?: string; pendingDream?: string },
  start: Start,
) {
  const initialMessageUuid = randomUUID()
  if (!options.requestId && !options.pendingDream) {
    const { id } = await start(initialMessageUuid)
    return { id, initialMessageUuid, replayed: false }
  }

  const lock = await actor.locks.acquire('creation:first-session')
  try {
    const sessions = Object.entries(await actor.sessions.readMetadata())
    if (options.requestId) {
      for (const [id, { creationSetup }] of sessions) {
        if (creationSetup?.requestId === options.requestId && creationSetup.userId === options.userId) {
          return { id, initialMessageUuid: creationSetup.initialMessageUuid, replayed: true }
        }
      }
    }
    // Re-read after acquiring the lock. A concurrent start or uninstall may have consumed this opt-in.
    const pending = options.pendingDream && (await actor.config.get('preferences'))?.dreamSetupId
    const dreamSetupId = pending && !sessions.some(([, meta]) => meta.creationSetup?.dreamSetupId === pending)
      ? pending : undefined
    const receipt = { userId: options.userId, requestId: options.requestId, initialMessageUuid, dreamSetupId }
    const { id } = await start(initialMessageUuid, receipt)
    if (pending) {
      // A newer install must keep its own pending activation. If cleanup fails, the session receipt still prevents a second activation.
      await updateConfigDoc(actor.config, 'preferences', current => current?.dreamSetupId === pending
        ? { ...current, dreamSetupId: undefined } : current).catch(error => captureException(error, { tags: { area: 'dream-setup' } }))
    }
    return { id, initialMessageUuid, replayed: false }
  } finally {
    await actor.locks.release('creation:first-session', lock)
  }
}
