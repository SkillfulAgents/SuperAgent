import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MockContainerClient } from './mock-container-client'
import { getSessionJsonlPath } from '@shared/lib/utils/file-storage'

describe('MockContainerClient.forkSession', () => {
  let dir: string
  let prev: string | undefined
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mock-fork-'))
    prev = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = dir
  })
  afterEach(async () => {
    if (prev) process.env.SUPERAGENT_DATA_DIR = prev
    else delete process.env.SUPERAGENT_DATA_DIR
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  it('copies the transcript with fresh uuids, remapped parents, and forkedFrom backlinks', async () => {
    const client = new MockContainerClient({ agentId: 'agent-a' })
    const src = await client.createSession({ initialMessage: '' })
    client.writeJsonlEntry(src.id, { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:00.000Z' })
    client.writeJsonlEntry(src.id, { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, timestamp: '2026-01-01T00:00:01.000Z' })

    const fork = await client.forkSession(src.id)
    expect(fork).not.toBeNull()

    const lines = (await fs.promises.readFile(getSessionJsonlPath('agent-a', fork!.id), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0].uuid).not.toBe('u1')
    expect(lines[1].parentUuid).toBe(lines[0].uuid)
    expect(lines[0].sessionId).toBe(fork!.id)
    expect(lines[0].forkedFrom).toEqual({ sessionId: src.id, messageUuid: 'u1' })
    expect(lines[1].forkedFrom).toEqual({ sessionId: src.id, messageUuid: 'a1' })

    // The fork is sendable: it lives in the sessions map like a created session.
    await expect(client.getSession(fork!.id)).resolves.not.toBeNull()
  })

  it('returns null for an unknown source', async () => {
    const client = new MockContainerClient({ agentId: 'agent-a' })
    expect(await client.forkSession('nope')).toBeNull()
  })
})
