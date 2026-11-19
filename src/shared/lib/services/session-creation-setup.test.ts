import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentLocks } from '@shared/lib/agent-actor/agent-locks'
import { createFakeAgentActor, createFakeRegistry } from '@shared/lib/agent-actor/testing/fake-agent-actor'
import { createInMemorySessionStore } from '@shared/lib/agent-actor/testing/in-memory-session-store'
import type { SessionMetadata, SessionMetadataMap } from '@shared/lib/types/agent'
import { startWithCreationSetup } from './session-creation-setup'

function fixture() {
  const { config } = createInMemorySessionStore('scout')
  const metadata: SessionMetadataMap = {}
  const locks = new AgentLocks()
  const fake = createFakeAgentActor('scout', {
    config,
    sessions: { readMetadata: async () => metadata },
    locks: { acquire: key => locks.acquire(key), release: async (key, token) => locks.release(key, token) },
  })
  const actor = createFakeRegistry([fake]).get('scout')
  const start = vi.fn(async (_uuid: string, receipt?: SessionMetadata['creationSetup']) => {
    const id = randomUUID()
    metadata[id] = { creationSetup: receipt }
    return { id }
  })
  return { actor, start }
}

it('concurrent starts with the same wizard request share the accepted session and message UUID', async () => {
  const { actor, start } = fixture()
  const options = { userId: 'alice', requestId: randomUUID() }
  const [first, replay] = await Promise.all([
    startWithCreationSetup(actor, options, start),
    startWithCreationSetup(actor, options, start),
  ])
  expect(replay).toMatchObject({ id: first.id, initialMessageUuid: first.initialMessageUuid, replayed: true })
  expect(start).toHaveBeenCalledTimes(1)
  const other = await startWithCreationSetup(actor, { ...options, userId: 'bob' }, start)
  expect(other.id).not.toBe(first.id)
})

it('keeps Dream pending after a failed start and activates it once across simultaneous first jobs', async () => {
  const { actor, start } = fixture()
  const pendingDream = randomUUID()
  const options = { userId: 'alice', pendingDream }
  await actor.config.put('preferences', { dreamSetupId: pendingDream, autoMemoryEnabled: false })
  start.mockRejectedValueOnce(new Error('Container unavailable'))
  await expect(startWithCreationSetup(actor, options, start)).rejects.toThrow('Container unavailable')
  expect((await actor.config.get('preferences'))?.dreamSetupId).toBe(pendingDream)
  await Promise.all([startWithCreationSetup(actor, options, start), startWithCreationSetup(actor, options, start)])
  const accepted = start.mock.calls.slice(1)
  expect(accepted.map(([, receipt]) => receipt?.dreamSetupId)).toEqual([pendingDream, undefined])
  expect(await actor.config.get('preferences')).toEqual({ autoMemoryEnabled: false })
})

it('honors an uninstall even when the caller read the old opt-in before it started', async () => {
  const { actor, start } = fixture()
  await startWithCreationSetup(actor, { userId: 'alice', pendingDream: randomUUID() }, start)
  expect(start.mock.calls[0][1]?.dreamSetupId).toBeUndefined()
})
