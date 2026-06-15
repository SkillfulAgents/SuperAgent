/**
 * Regression tests for SUP-209.
 *
 * deleteAgent() must NOT delete the host workspace when stopping the container
 * fails with a genuine runtime error (wedged VM, unexpected stop error). The
 * underlying container client is idempotent for already-stopped/missing
 * containers (it silently ignores "no such container"), so any rejection out of
 * containerManager.stopContainer is abnormal and must abort the deletion,
 * preserving the workspace and surfacing the failure to the API/UI.
 *
 * Dedicated file (not folded into agent-service.test.ts) to avoid cross-branch
 * merge conflicts. Reuses the same vi.mock harness header.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SAMPLE_CLAUDE_MD } from './__fixtures__/test-data'

// Mock containerManager before importing the service.
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

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    getClient: mockGetClient,
    getCachedInfo: mockGetCachedInfo,
    stopContainer: mockStopContainer,
    getHealthWarnings: vi.fn(() => []),
  },
}))

vi.mock('@shared/lib/proxy/review-manager', () => ({
  reviewManager: {
    getPendingReviewsForAgent: mockGetPendingReviewsForAgent,
  },
}))

// Import after mocking
import { deleteAgent, agentExists, AgentContainerStopError } from './agent-service'

describe('agent-service deleteAgent — container stop failure (SUP-209)', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-service-sup209-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
    vi.resetModules()
  })

  // Helper mirrors the harness in agent-service.test.ts
  async function createTestAgent(slug: string, claudeMdContent: string) {
    const workspaceDir = path.join(testDir, 'agents', slug, 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
    await fs.promises.writeFile(path.join(workspaceDir, 'CLAUDE.md'), claudeMdContent)
  }

  it('does not delete the workspace when stopping the container fails', async () => {
    await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)
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
    await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

    // Default mock resolves: an already-stopped/missing container stops without
    // throwing. The happy path must still remove the workspace.
    const result = await deleteAgent('test-agent')

    expect(result).toBe(true)
    expect(mockStopContainer).toHaveBeenCalledWith('test-agent')
    expect(await agentExists('test-agent')).toBe(false)
  })
})
