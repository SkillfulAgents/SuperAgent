import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentLocks } from '@shared/lib/agent-actor/agent-locks'
import { createFakeAgentActor, createFakeRegistry } from '@shared/lib/agent-actor/testing/fake-agent-actor'
import type { SessionMetadata, SessionMetadataMap } from '@shared/lib/types/agent'
import { startWithCreationSetup } from './session-creation-setup'

function fixture() {
  const metadata: SessionMetadataMap = {}
  const locks = new AgentLocks()
  const fake = createFakeAgentActor('scout', {
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
