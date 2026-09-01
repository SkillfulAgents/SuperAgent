import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContainerConflictError, ContainerNotFoundError } from '@shared/lib/container/types'

const {
  readSessionMetadata,
  getSession,
  getSessionMetadata,
  registerSession,
  deleteSession,
  sessionBelongsToAgent,
  sessionExists,
} = vi.hoisted(() => ({
  readSessionMetadata: vi.fn(),
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  registerSession: vi.fn(),
  deleteSession: vi.fn(),
  sessionBelongsToAgent: vi.fn(),
  sessionExists: vi.fn(),
}))

const { isSessionActive, ensureRunning, forkInContainer, deleteInContainer } = vi.hoisted(() => ({
  isSessionActive: vi.fn(),
  ensureRunning: vi.fn(),
  forkInContainer: vi.fn(),
  deleteInContainer: vi.fn(),
}))

const { copyDirectoryFiltered, streamJsonlFile } = vi.hoisted(() => ({
  copyDirectoryFiltered: vi.fn(),
  streamJsonlFile: vi.fn(async function* () { yield }),
}))

const { insertMessageAuthorsBestEffort, dbSelectFrom } = vi.hoisted(() => ({
  insertMessageAuthorsBestEffort: vi.fn(),
  dbSelectFrom: vi.fn(),
}))

vi.mock('./session-service', () => ({
  readSessionMetadata,
  getSession,
  getSessionMetadata,
  registerSession,
  deleteSession,
  sessionBelongsToAgent,
  sessionExists,
}))

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning,
    getClient: () => ({
      forkSession: forkInContainer,
      deleteSession: deleteInContainer,
    }),
  },
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { isSessionActive },
}))

vi.mock('@shared/lib/utils/file-storage', () => ({
  copyDirectoryFiltered,
  getAgentSessionsDir: () => '/sessions',
  getSessionJsonlPath: (slug: string, id: string) => `/sessions/${slug}/${id}.jsonl`,
  streamJsonlFile,
}))

vi.mock('@/api/routes/message-author', () => ({
  insertMessageAuthorsBestEffort,
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => dbSelectFrom(...args),
      }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  messageAuthor: { id: 'id', sessionId: 'session_id', userId: 'user_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
  inArray: (col: string, vals: string[]) => ({ col, vals }),
}))

import { forkSession } from './session-fork-service'

const source = {
  id: 'src-1',
  agentSlug: 'test-agent',
  name: 'Pricing',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastActivityAt: new Date('2026-01-01T00:00:00Z'),
  messageCount: 2,
}

const sourceMeta = {
  name: 'Pricing',
  createdAt: '2026-01-01T00:00:00Z',
  model: 'claude-sonnet-5',
  effort: 'high' as const,
  speed: 'fast' as const,
}

describe('forkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isSessionActive.mockReturnValue(false)
    sessionBelongsToAgent.mockResolvedValue(true)
    sessionExists.mockResolvedValue(true)
    readSessionMetadata.mockResolvedValue({ 'src-1': sourceMeta })
    getSession.mockResolvedValue(source)
    registerSession.mockResolvedValue(undefined)
    deleteSession.mockResolvedValue(true)
    forkInContainer.mockResolvedValue({ id: 'fork-1' })
    deleteInContainer.mockResolvedValue(true)
    copyDirectoryFiltered.mockResolvedValue(undefined)
    streamJsonlFile.mockImplementation(async function* () { yield })
    insertMessageAuthorsBestEffort.mockResolvedValue(true)
    dbSelectFrom.mockResolvedValue([])
  })

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

  it('does not re-read metadata for runtime choices', async () => {
    await forkSession('test-agent', 'src-1')
    expect(readSessionMetadata).toHaveBeenCalledTimes(1)
    expect(getSessionMetadata).not.toHaveBeenCalled()
    expect(getSession).toHaveBeenCalledWith('test-agent', 'src-1', { metadata: sourceMeta })
    expect(registerSession).toHaveBeenCalledWith(
      'test-agent',
      'fork-1',
      'Pricing (fork)',
      expect.objectContaining({ model: 'claude-sonnet-5', effort: 'high', speed: 'fast' }),
    )
  })

  it('throws 409 without reading or booting when the source is mid-turn', async () => {
    isSessionActive.mockReturnValue(true)
    await expect(forkSession('test-agent', 'src-1')).rejects.toMatchObject({
      name: 'ForkSessionError',
      status: 409,
    })
    expect(readSessionMetadata).not.toHaveBeenCalled()
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  it('throws 404 without booting when the source is unknown', async () => {
    sessionBelongsToAgent.mockResolvedValue(false)
    await expect(forkSession('test-agent', 'src-1')).rejects.toMatchObject({
      name: 'ForkSessionError',
      status: 404,
    })
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(forkInContainer).not.toHaveBeenCalled()
  })

  it('maps a container conflict and a gone session', async () => {
    forkInContainer.mockRejectedValueOnce(new ContainerConflictError('busy'))
    await expect(forkSession('test-agent', 'src-1')).rejects.toMatchObject({ status: 409 })

    forkInContainer.mockRejectedValueOnce(new ContainerNotFoundError('Session not found'))
    await expect(forkSession('test-agent', 'src-1')).rejects.toMatchObject({ status: 404 })
  })

  it('rolls back the copy when registration fails', async () => {
    registerSession.mockRejectedValue(new Error('metadata write failed'))
    deleteSession.mockRejectedValue(new Error('unlink failed'))
    await expect(forkSession('test-agent', 'src-1')).rejects.toThrow('metadata write failed')
    expect(deleteSession).toHaveBeenCalledWith('test-agent', 'fork-1')
    expect(deleteInContainer).toHaveBeenCalledWith('fork-1')
  })
})
