import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  SAMPLE_CLAUDE_MD,
  SAMPLE_CLAUDE_MD_MINIMAL,
  SAMPLE_CLAUDE_MD_NO_FRONTMATTER,
} from './__fixtures__/test-data'

// Mock containerManager before importing the service
vi.mock('@/lib/container/container-manager', () => ({
  containerManager: {
    getClient: vi.fn(() => ({
      getInfo: vi.fn(() => Promise.resolve({ status: 'stopped', port: null })),
      stop: vi.fn(() => Promise.resolve()),
    })),
  },
}))

// Import after mocking
import {
  getAgent,
  getAgentWithStatus,
  listAgents,
  listAgentsWithStatus,
  createAgent,
  updateAgent,
  deleteAgent,
  agentExists,
  getAgentClaudeMdContent,
  setAgentClaudeMdContent,
} from './agent-service'
import { containerManager } from '@shared/lib/container/container-manager'

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

    // Reset module cache
    vi.resetModules()
  })

  // Helper to create an agent directory with CLAUDE.md
  async function createTestAgent(slug: string, claudeMdContent: string) {
    const workspaceDir = path.join(testDir, 'agents', slug, 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
    await fs.promises.writeFile(
      path.join(workspaceDir, 'CLAUDE.md'),
      claudeMdContent
    )
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  describe('getAgent', () => {
    it('returns null for non-existent agent', async () => {
      const agent = await getAgent('nonexistent')
      expect(agent).toBeNull()
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
    })

    it('returns agent with running status when container is running', async () => {
      await createTestAgent('running-agent', SAMPLE_CLAUDE_MD)

      // Mock container as running
      vi.mocked(containerManager.getClient).mockReturnValue({
        getInfo: vi.fn(() =>
          Promise.resolve({ status: 'running', port: 3456 })
        ),
        stop: vi.fn(),
      } as any)

      const agent = await getAgentWithStatus('running-agent')

      expect(agent?.status).toBe('running')
      expect(agent?.containerPort).toBe(3456)
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

      expect(agents[0].frontmatter.name).toBe('New Agent')
      expect(agents[1].frontmatter.name).toBe('Old Agent')
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
  })

  describe('listAgentsWithStatus', () => {
    it('returns agents with their container status', async () => {
      await createTestAgent('agent-1', SAMPLE_CLAUDE_MD)
      await createTestAgent('agent-2', SAMPLE_CLAUDE_MD_MINIMAL)

      // Ensure mock returns stopped status for this test
      vi.mocked(containerManager.getClient).mockReturnValue({
        getInfo: vi.fn(() => Promise.resolve({ status: 'stopped', port: null })),
        stop: vi.fn(),
      } as any)

      const agents = await listAgentsWithStatus()

      expect(agents.length).toBe(2)
      agents.forEach((agent) => {
        expect(agent.status).toBe('stopped')
        expect(agent.containerPort).toBeNull()
      })
    })
  })

  // ============================================================================
  // Write Operations
  // ============================================================================

  describe('createAgent', () => {
    it('creates agent with name only', async () => {
      const agent = await createAgent({ name: 'New Agent' })

      expect(agent.name).toBe('New Agent')
      expect(agent.slug).toMatch(/^new-agent-[a-z0-9]{6}$/)
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

      // Verify description is in the file
      const content = await getAgentClaudeMdContent(agent.slug)
      expect(content).toContain('description: This is a description')
    })

    it('creates agent with custom instructions', async () => {
      const customInstructions = '# Custom Instructions\n\nDo special things.'
      const agent = await createAgent({
        name: 'Custom Agent',
        instructions: customInstructions,
      })

      expect(agent.instructions).toBe(customInstructions)
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

    it('updates agent name', async () => {
      await createTestAgent('test-agent', SAMPLE_CLAUDE_MD)

      const updated = await updateAgent('test-agent', { name: 'Updated Name' })

      expect(updated?.name).toBe('Updated Name')

      // Verify persisted
      const agent = await getAgent('test-agent')
      expect(agent?.frontmatter.name).toBe('Updated Name')
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

      const mockStop = vi.fn(() => Promise.resolve())
      vi.mocked(containerManager.getClient).mockReturnValue({
        getInfo: vi.fn(() => Promise.resolve({ status: 'running', port: 3456 })),
        stop: mockStop,
      } as any)

      await deleteAgent('test-agent')

      expect(mockStop).toHaveBeenCalled()
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
