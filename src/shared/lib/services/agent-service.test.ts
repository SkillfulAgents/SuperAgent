import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@shared/lib/db/schema'
import {
  SAMPLE_CLAUDE_MD,
  SAMPLE_CLAUDE_MD_MINIMAL,
  SAMPLE_CLAUDE_MD_NO_FRONTMATTER,
} from './__fixtures__/test-data'

// Mock the container host before importing the service
// Use vi.hoisted to ensure mock variables are available when vi.mock is hoisted
const { mockGetCachedInfo, mockStopContainer, mockGetClient, mockGetPendingReviewsForAgent } = vi.hoisted(() => {
  const mockGetCachedInfo = vi.fn((): { status: string; port: number | null } => ({ status: 'stopped', port: null }))
  const mockStopContainer = vi.fn(() => Promise.resolve())
  const mockGetInfo = vi.fn(() => Promise.resolve({ status: 'stopped', port: null }))
  const mockGetClient = vi.fn(() => ({
    getInfo: mockGetInfo,
  }))
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

// The catalog is the `agents` table: one in-memory database per test, so a
// test's agents never leak into the next.
let testDb: ReturnType<typeof drizzle>
let sqlite: InstanceType<typeof Database>
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

// Import after mocking
import {
  getAgent,
  getAgentRecord,
  getAgentWithStatus,
  listAgents,
  listAgentsWithStatus,
  createAgent,
  updateAgent,
  deleteAgent,
  agentExists,
  getAgentClaudeMdContent,
  setAgentClaudeMdContent,
  adoptAgentIdentityFromWorkspace,
  writeAgentIdentityProjection,
} from './agent-service'
import { importAgentDirectories } from '@shared/lib/db/data-migrations/0001-import-agents-from-directories'

describe('agent-service', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    // Create a unique temp directory
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-service-test-')
    )

    // Store original env and set test data dir
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir

    sqlite = new Database(':memory:')
    testDb = drizzle(sqlite, { schema })
    migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })

    // Reset mocks
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Restore env
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }

    // Clean up temp directory
    await fs.promises.rm(testDir, { recursive: true, force: true })
    sqlite.close()

    // Reset module cache
    vi.resetModules()
  })

  // Helper to create an agent the way an install found on disk is: a
  // directory with a CLAUDE.md, imported into the catalog by the data
  // migration that runs when the database is opened.
  async function createTestAgent(slug: string, claudeMdContent: string) {
    const workspaceDir = path.join(testDir, 'agents', slug, 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
    await fs.promises.writeFile(
      path.join(workspaceDir, 'CLAUDE.md'),
      claudeMdContent
    )
    importAgentDirectories(testDb)
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  describe('getAgent', () => {
    it('returns null for non-existent agent', async () => {
      const agent = await getAgent('nonexistent')
      expect(agent).toBeNull()
    })

    it('returns null when a directory exists but CLAUDE.md is missing, so it was never imported', async () => {
      await fs.promises.mkdir(path.join(testDir, 'agents', 'hollow', 'workspace'), { recursive: true })
      importAgentDirectories(testDb)

      const agent = await getAgent('hollow')

      expect(agent).toBeNull()
    })

    // Slugs reach getAgent from request bodies and stored policy rows, not
    // only from ResolveAgent, so anything that is not a catalog row must be
    // null — not a thrown read.
    it('returns null when the slug names a regular file in the agents dir', async () => {
      await fs.promises.mkdir(path.join(testDir, 'agents'), { recursive: true })
      await fs.promises.writeFile(path.join(testDir, 'agents', 'stray-file'), 'not an agent')
      importAgentDirectories(testDb)

      await expect(getAgent('stray-file')).resolves.toBeNull()
    })

    it('returns null for a slug that is not a valid path component', async () => {
      await expect(getAgent('bad\0slug')).resolves.toBeNull()
      await expect(getAgent('x'.repeat(300))).resolves.toBeNull()
    })

    it('still surfaces a real read error on an existing agent', async () => {
      // CLAUDE.md is a directory: the agent exists, its config is unreadable.
      // The workspace layer reports EISDIR as its own `not-a-file` error; what
      // matters here is that it propagates instead of reading as "no agent".
      const created = await createAgent({ name: 'Broken' })
      const claudeMd = path.join(testDir, 'agents', created.slug, 'workspace', 'CLAUDE.md')
      await fs.promises.rm(claudeMd)
      await fs.promises.mkdir(claudeMd)

      await expect(getAgent(created.slug)).rejects.toMatchObject({ name: 'WorkspaceFileError', code: 'not-a-file' })
    })

    it('reads an agent whose CLAUDE.md has gone missing as one with no instructions', async () => {
      const created = await createAgent({ name: 'Bare' })
      await fs.promises.rm(path.join(testDir, 'agents', created.slug, 'workspace', 'CLAUDE.md'))

      const agent = await getAgent(created.slug)

      expect(agent?.frontmatter.name).toBe('Bare')
      expect(agent?.instructions).toBe('')
    })

    it('answers with the catalog name, not the frontmatter, once they differ', async () => {
      // The agent editing its own frontmatter no longer renames it: the row
      // is the authority and the host rewrites the projection on its next write.
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)
      await setAgentClaudeMdContent('test-agent', SAMPLE_CLAUDE_MD.replace('name: Github Agent', 'name: Self Renamed'))

      expect((await getAgent('test-agent'))?.frontmatter.name).toBe('Github Agent')
      expect((await getAgentRecord('test-agent'))?.name).toBe('Github Agent')
    })

    it('returns agent config for existing agent', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const agent = await getAgent('test-agent')

      expect(agent).not.toBeNull()
      expect(agent?.slug).toBe('test-agent')
      expect(agent?.frontmatter.name).toBe('Github Agent')
      expect(agent?.frontmatter.description).toBe(
        'An agent that helps with GitHub tasks'
      )
      expect(agent?.frontmatter.createdAt).toBe('2026-01-24T01:30:50.090Z')
      expect(agent?.instructions).toContain('You are a helpful AI assistant')
    })

    it('handles CLAUDE.md without description', async () => {
      await createTestAgent('minimal-agent', SAMPLE_CLAUDE_MD_MINIMAL)

      const agent = await getAgent('minimal-agent')

      expect(agent?.frontmatter.name).toBe('Minimal Agent')
      expect(agent?.frontmatter.description).toBeUndefined()
    })

    it('uses slug as fallback name when frontmatter missing name', async () => {
      const noNameContent = `---
createdAt: "2026-01-01T00:00:00.000Z"
---

Instructions
`
      await createTestAgent('no-name-agent', noNameContent)

      const agent = await getAgent('no-name-agent')

      expect(agent?.frontmatter.name).toBe('no-name-agent')
    })

    it('handles CLAUDE.md without frontmatter', async () => {
      await createTestAgent('no-frontmatter', SAMPLE_CLAUDE_MD_NO_FRONTMATTER)

      const agent = await getAgent('no-frontmatter')

      expect(agent?.frontmatter.name).toBe('no-frontmatter') // Falls back to slug
      expect(agent?.instructions).toBe(SAMPLE_CLAUDE_MD_NO_FRONTMATTER)
    })
  })

  describe('getAgentWithStatus', () => {
    it('returns null for non-existent agent', async () => {
      const agent = await getAgentWithStatus('nonexistent')
      expect(agent).toBeNull()
    })

    it('returns agent with stopped status', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const agent = await getAgentWithStatus('test-agent')

      expect(agent).not.toBeNull()
      expect(agent?.status).toBe('stopped')
      expect(agent?.containerPort).toBeNull()
      expect(agent?.sessionCount).toBe(0)
      expect(agent?.lastActivityAt).toBeNull()
      expect(agent?.hasActiveSessions).toBe(false)
      expect(agent?.hasSessionsAwaitingInput).toBe(false)
    })

    it('returns agent with running status when container is running', async () => {
      await createTestAgent('running-agent', SAMPLE_CLAUDE_MD)

      // Mock container as running
      mockGetCachedInfo.mockReturnValueOnce({ status: 'running', port: 3456 })

      const agent = await getAgentWithStatus('running-agent')

      expect(agent?.status).toBe('running')
      expect(agent?.containerPort).toBe(3456)
    })

    it('can omit filesystem session summaries for command responses', async () => {
      await createTestAgent('command-agent', SAMPLE_CLAUDE_MD)

      const agent = await getAgentWithStatus('command-agent', { includeSummary: false })

      expect(agent).not.toBeNull()
      expect(agent).not.toHaveProperty('sessionCount')
      expect(agent).not.toHaveProperty('lastActivityAt')
      expect(agent).not.toHaveProperty('hasActiveSessions')
      expect(agent).not.toHaveProperty('hasSessionsAwaitingInput')
    })

    it('surfaces awaiting input when agent has pending proxy reviews and no active sessions', async () => {
      await createTestAgent('review-agent', SAMPLE_CLAUDE_MD)
      mockGetPendingReviewsForAgent.mockReturnValueOnce([
        { id: 'review-1', agentSlug: 'review-agent', accountId: 'acc-1', toolkit: 'gmail', method: 'GET', targetPath: '/messages', matchedScopes: [], scopeDescriptions: {} },
      ])

      const agent = await getAgentWithStatus('review-agent')

      expect(agent?.hasSessionsAwaitingInput).toBe(true)
    })
  })

  describe('listAgents', () => {
    it('returns empty array when no agents exist', async () => {
      const agents = await listAgents()
      expect(agents).toEqual([])
    })

    it('lists all agents', async () => {
      await createTestAgent('agent-1', SAMPLE_CLAUDE_MD)
      await createTestAgent('agent-2', SAMPLE_CLAUDE_MD_MINIMAL)

      const agents = await listAgents()

      expect(agents.length).toBe(2)
      expect(agents.map((a) => a.slug).sort()).toEqual(['agent-1', 'agent-2'])
    })

    it('sorts agents by creation date (newest first)', async () => {
      const oldContent = `---
name: Old Agent
createdAt: "2025-01-01T00:00:00.000Z"
---
Instructions`

      const newContent = `---
name: New Agent
createdAt: "2026-01-01T00:00:00.000Z"
---
Instructions`

      await createTestAgent('old-agent', oldContent)
      await createTestAgent('new-agent', newContent)

      const agents = await listAgents()

      expect(agents[0].name).toBe('New Agent')
      expect(agents[1].name).toBe('Old Agent')
    })

    it('skips directories without CLAUDE.md', async () => {
      await createTestAgent('valid-agent', SAMPLE_CLAUDE_MD)

      // Create empty agent directory
      await fs.promises.mkdir(
        path.join(testDir, 'agents', 'invalid-agent', 'workspace'),
        { recursive: true }
      )

      const agents = await listAgents()

      expect(agents.length).toBe(1)
      expect(agents[0].slug).toBe('valid-agent')
    })

    it('orders many agents newest-first regardless of directory or creation order', async () => {
      // Slug order, directory-creation order and createdAt order all disagree,
      // so the listing must sort purely by createdAt.
      const agents = [
        ['agent-c', '2026-03-01T00:00:00.000Z'],
        ['agent-a', '2026-05-01T00:00:00.000Z'],
        ['agent-e', '2026-01-01T00:00:00.000Z'],
        ['agent-b', '2026-04-01T00:00:00.000Z'],
        ['agent-d', '2026-02-01T00:00:00.000Z'],
        ['agent-f', '2026-06-01T00:00:00.000Z'],
      ] as const
      for (const [slug, createdAt] of agents) {
        await createTestAgent(slug, `---\nname: ${slug}\ncreatedAt: "${createdAt}"\n---\nInstructions`)
      }

      const listed = await listAgents()

      expect(listed.map((a) => a.slug)).toEqual([
        'agent-f', 'agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e',
      ])
    })

    it('skips an agent whose CLAUDE.md is missing while keeping its siblings', async () => {
      await createTestAgent('first', SAMPLE_CLAUDE_MD)
      await fs.promises.mkdir(path.join(testDir, 'agents', 'hollow', 'workspace'), { recursive: true })
      await createTestAgent('last', SAMPLE_CLAUDE_MD)

      const listed = await listAgents()

      expect(listed.map((a) => a.slug).sort()).toEqual(['first', 'last'])
    })
  })

  describe('listAgentsWithStatus', () => {
    it('returns agents with their container status and without instructions', async () => {
      await createTestAgent('agent-1', SAMPLE_CLAUDE_MD)
      await createTestAgent('agent-2', SAMPLE_CLAUDE_MD_MINIMAL)

      // Default mock returns stopped status
      const agents = await listAgentsWithStatus()

      expect(agents.length).toBe(2)
      agents.forEach((agent) => {
        expect(agent.status).toBe('stopped')
        expect(agent.containerPort).toBeNull()
        expect(agent).not.toHaveProperty('instructions')
      })
      expect(agents.map((agent) => agent.name).sort()).toEqual(['Github Agent', 'Minimal Agent'])
    })

    it('restricts the listing to the given slugs, newest first', async () => {
      await createTestAgent('agent-1', SAMPLE_CLAUDE_MD)
      await createTestAgent('agent-2', SAMPLE_CLAUDE_MD_MINIMAL)
      await createTestAgent('agent-3', SAMPLE_CLAUDE_MD)

      const agents = await listAgentsWithStatus({ slugs: ['agent-2', 'agent-3', 'not-an-agent'] })

      expect(agents.map((agent) => agent.slug)).toEqual(['agent-3', 'agent-2'])
    })
  })

  // ============================================================================
  // Write Operations
  // ============================================================================

  describe('createAgent', () => {
    it('creates agent with name only', async () => {
      const agent = await createAgent({ name: 'New Agent' })

      expect(agent.name).toBe('New Agent')
      // Identity is now an opaque minted id; the name lives in the projected displaySlug.
      expect(agent.slug).toMatch(/^[a-z0-9]{10}$/)
      expect(agent.displaySlug).toMatch(/^new-agent-[a-z0-9]{10}$/)
      expect(agent.status).toBe('stopped')
      expect(agent.containerPort).toBeNull()
      expect(agent.instructions).toContain('You are a helpful AI assistant')

      // Verify file was created
      const exists = await agentExists(agent.slug)
      expect(exists).toBe(true)
    })

    it('creates agent with description', async () => {
      const agent = await createAgent({
        name: 'Described Agent',
        description: 'This is a description',
      })

      expect(agent.description).toBe('This is a description')

      // The catalog holds it, and the file carries the projection
      expect((await getAgentRecord(agent.slug))?.description).toBe('This is a description')
      const content = await getAgentClaudeMdContent(agent.slug)
      expect(content).toContain('description: This is a description')
      expect(content).toContain('name: Described Agent')
    })

    it('creates agent with custom instructions', async () => {
      const customInstructions = '# Custom Instructions\n\nDo special things.'
      const agent = await createAgent({
        name: 'Custom Agent',
        instructions: customInstructions,
      })

      expect(agent.instructions).toBe(customInstructions)
    })

    it('records the agent before writing its workspace, and takes the row back if the write fails', async () => {
      // Pin the minted slug and put a file where its directory must go, so
      // the workspace write fails after the row exists.
      const slug = 'a'.repeat(10)
      await fs.promises.mkdir(path.join(testDir, 'agents'), { recursive: true })
      const random = vi.spyOn(Math, 'random').mockReturnValue(0)
      try {
        await fs.promises.writeFile(path.join(testDir, 'agents', slug), 'in the way')
        // mint() also refuses a slug whose directory exists, so it falls back
        // to the timestamp form; block that too by making every candidate
        // collide with a file.
        await expect(createAgent({ name: 'Doomed' })).rejects.toThrow()
      } finally {
        random.mockRestore()
      }

      expect(await agentExists(slug)).toBe(false)
      expect(await listAgents()).toEqual([])
    })

    it('creates unique slugs for same name', async () => {
      const agent1 = await createAgent({ name: 'Same Name' })
      const agent2 = await createAgent({ name: 'Same Name' })

      expect(agent1.slug).not.toBe(agent2.slug)
    })
  })

  describe('updateAgent', () => {
    it('returns null for non-existent agent', async () => {
      const result = await updateAgent('nonexistent', { name: 'New Name' })
      expect(result).toBeNull()
    })

    it('updates agent name in the catalog and projects it into CLAUDE.md', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const updated = await updateAgent('test-agent', { name: 'Updated Name' })

      expect(updated?.name).toBe('Updated Name')
      expect(updated?.displaySlug).toBe('test-agent') // legacy slugs are never re-prettified

      // Verify persisted
      const agent = await getAgent('test-agent')
      expect(agent?.frontmatter.name).toBe('Updated Name')
      expect((await getAgentRecord('test-agent'))?.name).toBe('Updated Name')
      expect(await getAgentClaudeMdContent('test-agent')).toContain('name: Updated Name')
    })

    it('updates agent description', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const updated = await updateAgent('test-agent', {
        description: 'New description',
      })

      expect(updated?.description).toBe('New description')
    })

    it('removes description when set to empty string', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const updated = await updateAgent('test-agent', { description: '' })

      expect(updated?.description).toBeUndefined()
      expect(await getAgentRecord('test-agent')).not.toHaveProperty('description')
      expect(await getAgentClaudeMdContent('test-agent')).not.toContain('description:')
    })

    it('updates agent instructions', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const updated = await updateAgent('test-agent', {
        instructions: 'New instructions',
      })

      expect(updated?.instructions).toBe('New instructions')
    })

    it('preserves unchanged fields', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      await updateAgent('test-agent', { name: 'New Name' })

      const agent = await getAgent('test-agent')
      expect(agent?.frontmatter.name).toBe('New Name')
      expect(agent?.frontmatter.description).toBe(
        'An agent that helps with GitHub tasks'
      )
      expect(agent?.instructions).toContain('You are a helpful AI assistant')
    })
  })

  describe('identity projection', () => {
    it('rewrites the frontmatter from the catalog and keeps other keys and the body', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)
      await setAgentClaudeMdContent('test-agent', '---\nname: Template Name\nversion: 2.0.0\n---\nTemplate body\n')

      await writeAgentIdentityProjection('test-agent')

      const content = await getAgentClaudeMdContent('test-agent')
      expect(content).toContain('name: Github Agent')
      expect(content).toContain('description: An agent that helps with GitHub tasks')
      expect(content).toContain('createdAt: "2026-01-24T01:30:50.090Z"')
      expect(content).toContain('version: 2.0.0')
      expect(content).toContain('Template body')
    })

    it('does nothing for an unknown agent or one without a CLAUDE.md', async () => {
      await writeAgentIdentityProjection('nonexistent')
      const created = await createAgent({ name: 'Bare' })
      await fs.promises.rm(path.join(testDir, 'agents', created.slug, 'workspace', 'CLAUDE.md'))
      await writeAgentIdentityProjection(created.slug)
      expect(await getAgentClaudeMdContent(created.slug)).toBeNull()
    })

    it('adopts the name and description a template brought, keeping the creation date', async () => {
      const created = await createAgent({ name: 'Placeholder' })
      await setAgentClaudeMdContent(created.slug, '---\nname: Template Name\ndescription: From the template\ncreatedAt: "2020-01-01T00:00:00.000Z"\n---\nBody\n')

      const adopted = await adoptAgentIdentityFromWorkspace(created.slug)

      expect(adopted).toMatchObject({ name: 'Template Name', description: 'From the template', createdAt: created.createdAt })
      const content = await getAgentClaudeMdContent(created.slug)
      expect(content).toContain('name: Template Name')
      expect(content).toContain(`createdAt: "${created.createdAt.toISOString()}"`)
      expect(content).not.toContain('2020-01-01')
    })

    it('lets an override win over the template name, and keeps the row name when the template has none', async () => {
      const created = await createAgent({ name: 'Chosen' })
      await setAgentClaudeMdContent(created.slug, '---\nname: Template Name\n---\nBody\n')
      expect((await adoptAgentIdentityFromWorkspace(created.slug, { name: '  Override  ' }))?.name).toBe('Override')

      await setAgentClaudeMdContent(created.slug, 'No frontmatter\n')
      expect((await adoptAgentIdentityFromWorkspace(created.slug, { name: '' }))?.name).toBe('Override')
      expect(await adoptAgentIdentityFromWorkspace('nonexistent')).toBeNull()
    })
  })

  describe('deleteAgent', () => {
    it('returns false for non-existent agent', async () => {
      const result = await deleteAgent('nonexistent')
      expect(result).toBe(false)
    })

    it('deletes agent and returns true', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const result = await deleteAgent('test-agent')

      expect(result).toBe(true)
      expect(await agentExists('test-agent')).toBe(false)
    })

    it('stops container before deleting', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)
      mockStopContainer.mockClear()

      await deleteAgent('test-agent')

      expect(mockStopContainer).toHaveBeenCalledWith('test-agent')
    })
  })

  // ============================================================================
  // Utility Functions
  // ============================================================================

  describe('agentExists', () => {
    it('returns false for non-existent agent', async () => {
      const exists = await agentExists('nonexistent')
      expect(exists).toBe(false)
    })

    it('returns true for existing agent', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const exists = await agentExists('test-agent')
      expect(exists).toBe(true)
    })
  })

  describe('getAgentClaudeMdContent', () => {
    it('returns null for non-existent agent', async () => {
      const content = await getAgentClaudeMdContent('nonexistent')
      expect(content).toBeNull()
    })

    it('returns raw CLAUDE.md content', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const content = await getAgentClaudeMdContent('test-agent')
      expect(content).toBe(SAMPLE_CLAUDE_MD)
    })
  })

  describe('setAgentClaudeMdContent', () => {
    it('writes raw CLAUDE.md content', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const newContent = '# New Content\n\nNew instructions.'
      await setAgentClaudeMdContent('test-agent', newContent)

      const content = await getAgentClaudeMdContent('test-agent')
      expect(content).toBe(newContent)
    })
  })
})
