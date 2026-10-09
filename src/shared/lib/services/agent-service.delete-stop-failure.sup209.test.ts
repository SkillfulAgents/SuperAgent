/**
 * Regression tests for SUP-209.
 *
 * deleteAgent() must NOT delete the host workspace when stopping the container
 * fails with a genuine runtime error (wedged VM, unexpected stop error). The
 * underlying container client is idempotent for already-stopped/missing
 * containers (it silently ignores "no such container"), so any rejection out of
 * the runtime's stopContainer is abnormal and must abort the deletion,
 * preserving the workspace and surfacing the failure to the API/UI.
 *
 * Dedicated file (not folded into agent-service.test.ts) to avoid cross-branch
 * merge conflicts. Reuses the same vi.mock harness header.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { ContainerStopDeferredError } from '@shared/lib/container/volume-stop-schema'
import { assertAgentCanStart } from '@shared/lib/container/lifecycle-gate'
import { SAMPLE_INSTRUCTIONS } from './__fixtures__/test-data'

// Mock the container host before importing the service.
// Use vi.hoisted so mock variables exist when vi.mock is hoisted.
const { mockGetCachedInfo, mockStopContainer, mockGetClient, mockGetPendingReviewsForAgent } =
  vi.hoisted(() => {
    const mockGetCachedInfo = vi.fn((): { status: string; port: number | null } => ({
      status: 'stopped',
      port: null,
    }))
    const mockStopContainer = vi.fn((): Promise<void> => Promise.resolve())
    const mockGetInfo = vi.fn(() => Promise.resolve({ status: 'stopped', port: null }))
    const mockGetClient = vi.fn(() => ({ getInfo: mockGetInfo }))
    const mockGetPendingReviewsForAgent = vi.fn((): unknown[] => [])
    return { mockGetCachedInfo, mockStopContainer, mockGetClient, mockGetPendingReviewsForAgent }
  })

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      getClient: mockGetClient,
      getCachedInfo: mockGetCachedInfo,
      stopContainer: mockStopContainer,
      getHealthWarnings: vi.fn(() => []),
      // deleteAgent evicts the handle once the agent is gone (dropRuntime).
      removeClient: vi.fn(),
    }),
  }
})

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    getPendingReviewsForAgent: mockGetPendingReviewsForAgent,
  },
}))

let testDb: AppDatabase
let database: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

// Import after mocking
import { deleteAgent, agentExists, AgentContainerStopError } from './agent-service'
import { importAgentDirectories } from '@shared/lib/db/data-migrations/0001-import-agents-from-directories'

describe('agent-service deleteAgent — container stop failure (SUP-209)', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-service-sup209-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    database = await createTestDatabase()
    testDb = database.db
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
    await database.close()
    vi.resetModules()
  })

  // Helper mirrors the harness in agent-service.test.ts
  async function createTestAgent(slug: string, instructionsContent: string) {
    const workspaceDir = path.join(testDir, 'agents', slug, 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
    await fs.promises.writeFile(path.join(workspaceDir, 'AGENTS.md'), instructionsContent)
    await importAgentDirectories(testDb)
  }

  it('does not delete the workspace when stopping the container fails', async () => {
    await createTestAgent('test-agent', SAMPLE_INSTRUCTIONS)
    mockStopContainer.mockRejectedValueOnce(
      new Error('runtime wedged: cannot stop container')
    )

    // A genuine stop failure must abort the deletion (reject), not silently
    // swallow and proceed. It rejects with the typed AgentContainerStopError so
    // the route can map it to an actionable 409; the underlying cause message is
    // preserved for the server log.
    const error = await deleteAgent('test-agent').catch((e) => e)
    expect(error).toBeInstanceOf(AgentContainerStopError)
    expect((error as Error).message).toMatch(/runtime/)

    // The host workspace must survive — removeDirectory must NOT have run.
    expect(await agentExists('test-agent')).toBe(true)
  })

  it('still deletes the agent when the container stop is a benign no-op', async () => {
    await createTestAgent('test-agent', SAMPLE_INSTRUCTIONS)

    // Default mock resolves: an already-stopped/missing container stops without
    // throwing. The happy path must still remove the workspace.
    const result = await deleteAgent('test-agent')

    expect(result).toBe(true)
    expect(mockStopContainer).toHaveBeenCalledWith('test-agent', undefined)
    expect(await agentExists('test-agent')).toBe(false)
  })
  it('keeps upload credentials and peripheral data when drain is refused', async () => {
    await createTestAgent('test-agent', SAMPLE_INSTRUCTIONS)
    const cause = new ContainerStopDeferredError('Uploads are pending')
    mockStopContainer.mockRejectedValueOnce(cause)
    const cleanup = vi.fn()
    await expect(deleteAgent('test-agent', { cleanup })).rejects.toMatchObject({ cause })
    expect(cleanup).not.toHaveBeenCalled()
    expect(() => assertAgentCanStart('test-agent')).not.toThrow()
    expect(await agentExists('test-agent')).toBe(true)
  })

  it('allows explicit discard, then cleans up before deleting the workspace', async () => {
    await createTestAgent('test-agent', SAMPLE_INSTRUCTIONS)
    const cleanup = vi.fn(async () => {
      expect(mockStopContainer).toHaveBeenCalledWith('test-agent', { discardPendingUploads: true })
      expect(await agentExists('test-agent')).toBe(true)
      expect(() => assertAgentCanStart('test-agent')).toThrow('being deleted')
    })
    await expect(deleteAgent('test-agent', { cleanup, discardPendingUploads: true })).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(await agentExists('test-agent')).toBe(false)
  })

  it('preserves the workspace if cleanup fails after the safe stop', async () => {
    await createTestAgent('test-agent', SAMPLE_INSTRUCTIONS)
    await expect(deleteAgent('test-agent', { cleanup: async () => { throw new Error('cleanup failed') } })).rejects.toThrow('cleanup failed')
    expect(await agentExists('test-agent')).toBe(true)
  })
})
