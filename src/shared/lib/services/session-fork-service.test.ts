import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { messageAuthor, user } from '@shared/lib/db/schema'
import { ContainerNotFoundError } from '@shared/lib/container/types'

const {
  readSessionMetadata,
  getSession,
  getSessionMetadata,
  registerSession,
  deleteSession,
  sessionIsKnown,
} = vi.hoisted(() => ({
  readSessionMetadata: vi.fn(),
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  registerSession: vi.fn(),
  deleteSession: vi.fn(),
  sessionIsKnown: vi.fn(),
}))

const { isSessionActive, ensureRunning, forkInContainer, releaseInContainer, deleteInContainer } = vi.hoisted(() => ({
  isSessionActive: vi.fn(),
  ensureRunning: vi.fn(),
  forkInContainer: vi.fn(),
  releaseInContainer: vi.fn(),
  deleteInContainer: vi.fn(),
}))

// The derived-file copy and the raw transcript read, as the actor binds them
// from the transcript ops; gated by the tests that check they overlap.
const { copyDirectoryFiltered, streamJsonlFile } = vi.hoisted(() => ({
  copyDirectoryFiltered: vi.fn(),
  streamJsonlFile: vi.fn(async function* (): AsyncGenerator<unknown> { yield }),
}))

vi.mock('@shared/lib/agent-actor/local-transcript-ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/agent-actor/local-transcript-ops')>()),
  copyDerivedSessionFiles: (...args: unknown[]) => copyDirectoryFiltered(...args),
}))
vi.mock('@shared/lib/agent-actor/jsonl-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/agent-actor/jsonl-files')>()),
  streamJsonl: () => streamJsonlFile(),
}))

vi.mock('./session-service', () => ({
  readSessionMetadata,
  getSession,
  getSessionMetadata,
  registerSession,
  deleteSession,
  sessionIsKnown,
}))

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning,
      getClient: () => ({
        forkSession: forkInContainer,
        releaseSession: releaseInContainer,
        deleteSession: deleteInContainer,
      }),
    }),
  }
})

vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
    isActive: (slug, sessionId) => isSessionActive(slug, sessionId),
  }),
}))

vi.mock('@shared/lib/utils/file-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/utils/file-storage')>()),
  getAgentWorkspaceDir: () => '/',
}))

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({
  get db() { return handle.db },
}))

import { forkSession } from './session-fork-service'

const source = {
  id: 'src-1',
  agentSlug: 'test-agent',
  name: 'Pricing',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastActivityAt: new Date('2026-01-01T00:00:00Z'),
}

const sourceMeta = {
  name: 'Pricing',
  createdAt: '2026-01-01T00:00:00Z',
  model: 'claude-sonnet-5',
  effort: 'high' as const,
  speed: 'fast' as const,
}

describe('forkSession', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    vi.clearAllMocks()
    isSessionActive.mockReturnValue(false)
    sessionIsKnown.mockResolvedValue(true)
    readSessionMetadata.mockResolvedValue({ 'src-1': sourceMeta })
    getSession.mockResolvedValue(source)
    registerSession.mockResolvedValue(undefined)
    deleteSession.mockResolvedValue(true)
    forkInContainer.mockResolvedValue({ id: 'fork-1' })
    releaseInContainer.mockResolvedValue(true)
    deleteInContainer.mockResolvedValue(true)
    copyDirectoryFiltered.mockResolvedValue(undefined)
    streamJsonlFile.mockImplementation(async function* () { yield })
  })
  afterEach(async () => { await handle.close() })

  it('starts the container boot alongside the source read', async () => {
    let releaseGet!: () => void
    let releaseBoot!: () => void
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve
    })
    const bootGate = new Promise<void>((resolve) => {
      releaseBoot = resolve
    })
    let getCalled = false
    let bootCalled = false
    getSession.mockImplementation(async () => {
      getCalled = true
      await getGate
      return source
    })
    ensureRunning.mockImplementation(async () => {
      bootCalled = true
      await bootGate
    })

    const pending = forkSession('test-agent', 'src-1')
    await vi.waitFor(() => {
      expect(getCalled).toBe(true)
      expect(bootCalled).toBe(true)
    })
    releaseGet()
    releaseBoot()
    await pending
  })

  it('copies sidecars and attribution at the same time', async () => {
    let releaseCopy!: () => void
    let releaseAttr!: () => void
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const attrGate = new Promise<void>((resolve) => {
      releaseAttr = resolve
    })
    let copyCalled = false
    let attrCalled = false
    copyDirectoryFiltered.mockImplementation(async () => {
      copyCalled = true
      await copyGate
    })
    streamJsonlFile.mockImplementation(async function* () {
      attrCalled = true
      await attrGate
      yield { type: 'assistant' }
    })

    const pending = forkSession('test-agent', 'src-1', { copyAttribution: true })
    await vi.waitFor(() => {
      expect(copyCalled).toBe(true)
      expect(attrCalled).toBe(true)
    })
    releaseCopy()
    releaseAttr()
    await pending
  })

  it('copies re-keyed integration cards and leaves queued delivery IDs with the source', async () => {
    const card = { sessionId: 'src-1', agentSlug: 'test-agent', integrationId: 'integration-1', display: '{"version":1}' }
    await handle.db.insert(messageAuthor).values([{ ...card, id: 'old-user' }, { ...card, id: 'queued-delivery' }]).run()
    streamJsonlFile.mockImplementation(async function* () {
      yield { type: 'user', uuid: 'new-user', forkedFrom: { sessionId: 'src-1', messageUuid: 'old-user' } }
      yield { type: 'assistant', uuid: 'new-assistant', forkedFrom: { sessionId: 'src-1', messageUuid: 'old-assistant' } }
      yield {
        type: 'attachment', uuid: 'new-attachment', forkedFrom: { sessionId: 'src-1', messageUuid: 'old-attachment' },
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'delivery', source_uuid: 'queued-delivery' },
      }
    })
    const fork = await forkSession('test-agent', 'src-1')
    expect(await handle.db.select().from(messageAuthor).where(eq(messageAuthor.sessionId, fork.id)).all()).toMatchObject([
      { id: 'new-user', agentSlug: 'test-agent', userId: null, integrationId: 'integration-1', display: '{"version":1}' },
    ])
    expect(await handle.db.select().from(messageAuthor).where(eq(messageAuthor.id, 'queued-delivery')).all()).toMatchObject([
      { ...card, id: 'queued-delivery' },
    ])
  })

  it('copies regular and queued agent senders from this recipient into the fork', async () => {
    await handle.db.insert(user).values({ id: 'payer', name: 'Payer', email: 'payer@example.test' }).run()
    const author = { sessionId: 'src-1', agentSlug: 'test-agent', authorAgentSlug: 'research-agent', billedUserId: 'payer' }
    await handle.db.insert(messageAuthor).values([
      { ...author, id: 'old-user' },
      { ...author, id: 'queue-id' },
      { ...author, id: 'only-in-import', agentSlug: 'other-recipient' },
    ]).run()
    streamJsonlFile.mockImplementation(async function* () {
      yield { type: 'user', uuid: 'new-user', forkedFrom: { sessionId: 'src-1', messageUuid: 'old-user' } }
      yield { type: 'user', uuid: 'unattributed', forkedFrom: { sessionId: 'src-1', messageUuid: 'only-in-import' } }
      yield {
        type: 'attachment', uuid: 'new-attachment', forkedFrom: { sessionId: 'src-1', messageUuid: 'old-attachment' },
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'follow up', source_uuid: 'queue-id' },
      }
    })
    const fork = await forkSession('test-agent', 'src-1', { copyAttribution: true })
    expect(await handle.db.select().from(messageAuthor).where(eq(messageAuthor.sessionId, fork.id)).orderBy(messageAuthor.id).all()).toMatchObject([
      { ...author, sessionId: fork.id, id: 'new-user' },
      { ...author, sessionId: fork.id, id: 'queue-id' },
    ])
    expect(await handle.db.select().from(messageAuthor).where(eq(messageAuthor.id, 'queue-id')).all()).toHaveLength(2)
  })

  it('does not scan the fork without auth attribution or integration authors', async () => {
    await forkSession('test-agent', 'src-1')
    expect(streamJsonlFile).not.toHaveBeenCalled()
  })

  it('does not re-read metadata for runtime choices', async () => {
    await forkSession('test-agent', 'src-1')
    expect(readSessionMetadata).toHaveBeenCalledTimes(1)
    expect(getSessionMetadata).not.toHaveBeenCalled()
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({ slug: 'test-agent' }), 'src-1', { metadata: sourceMeta })
    expect(registerSession).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'test-agent' }),
      'fork-1',
      'Pricing (fork)',
      expect.objectContaining({ model: 'claude-sonnet-5', effort: 'high', speed: 'fast' }),
    )
  })

  it('forks a source that is mid-turn', async () => {
    isSessionActive.mockReturnValue(true)
    await forkSession('test-agent', 'src-1')
    expect(forkInContainer).toHaveBeenCalled()
  })

  it('throws 404 without booting when the source is unknown', async () => {
    sessionIsKnown.mockResolvedValue(false)
    await expect(forkSession('test-agent', 'src-1')).rejects.toMatchObject({
      name: 'SessionForkFailedError',
      status: 404,
    })
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(forkInContainer).not.toHaveBeenCalled()
  })

  it('maps a gone session to 404', async () => {
    forkInContainer.mockRejectedValueOnce(new ContainerNotFoundError('Session not found'))
    await expect(forkSession('test-agent', 'src-1')).rejects.toMatchObject({ status: 404 })
  })

  it('rolls back the copy when registration fails', async () => {
    registerSession.mockRejectedValue(new Error('metadata write failed'))
    deleteSession.mockRejectedValue(new Error('unlink failed'))
    await expect(forkSession('test-agent', 'src-1')).rejects.toThrow('metadata write failed')
    expect(releaseInContainer).toHaveBeenCalledExactlyOnceWith('fork-1')
    expect(deleteSession).toHaveBeenCalledWith(expect.objectContaining({ slug: 'test-agent' }), 'fork-1')
    expect(deleteInContainer).toHaveBeenCalledWith('fork-1')
  })
})
