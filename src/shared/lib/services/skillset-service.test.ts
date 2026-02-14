import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type {
  SkillsetConfig,
  SkillsetIndex,
  InstalledSkillMetadata,
} from '@shared/lib/types/skillset'

// ============================================================================
// Hoisted Mocks
// ============================================================================

const { mockExecFile, mockAnthropicCreate, mockGetApiKey, mockGetModels } = vi.hoisted(() => {
  const mockExecFile = vi.fn<
    (cmd: string, args: string[], opts?: unknown) => { stdout: string; stderr: string }
  >()
  const mockAnthropicCreate = vi.fn()
  const mockGetApiKey = vi.fn((): string | undefined => undefined)
  const mockGetModels = vi.fn(() => ({
    summarizerModel: 'claude-haiku-4-5-20251001',
    agentModel: 'claude-sonnet-4-20250514',
  }))
  return { mockExecFile, mockAnthropicCreate, mockGetApiKey, mockGetModels }
})

// child_process.execFile is callback-based; the service wraps it with promisify.
// Node's real execFile has a custom promisify symbol that returns { stdout, stderr }.
// We must replicate this so that `const { stdout } = await execFileAsync(...)` works.
vi.mock('child_process', () => {
  const execFileFn = (...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      stdout?: string,
      stderr?: string,
    ) => void
    const callArgs = args.slice(0, -1) as [string, string[], unknown?]
    try {
      const result = mockExecFile(...callArgs)
      callback(null, result?.stdout ?? '', result?.stderr ?? '')
    } catch (err) {
      callback(err as Error)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(execFileFn as any)[Symbol.for('nodejs.util.promisify.custom')] = async (
    ...args: unknown[]
  ) => {
    const callArgs = args as [string, string[], unknown?]
    const result = mockExecFile(...callArgs)
    return { stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' }
  }
  return { execFile: execFileFn }
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages: { create: typeof mockAnthropicCreate }
    constructor() {
      this.messages = { create: mockAnthropicCreate }
    }
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: mockGetApiKey,
  getEffectiveModels: mockGetModels,
}))

// Bypass retry delays in tests
vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}))

import {
  contentHash,
  parseSkillFrontmatter,
  urlToSkillsetId,
  getAgentSkillsWithStatus,
  refreshAgentSkills,
  publishSkillToSkillset,
  getSkillPublishInfo,
  validateSkillsetUrl,
} from './skillset-service'

// ============================================================================
// Test Suite
// ============================================================================

describe('skillset-service', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'skillset-service-test-'),
    )
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
  })

  // ============================================================================
  // Helpers
  // ============================================================================

  async function createSkillDir(
    agentSlug: string,
    skillDirName: string,
    skillMdContent: string,
    metadata?: InstalledSkillMetadata,
  ): Promise<string> {
    const skillDir = path.join(
      testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills', skillDirName,
    )
    await fs.promises.mkdir(skillDir, { recursive: true })
    await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8')
    if (metadata) {
      await fs.promises.writeFile(
        path.join(skillDir, '.skillset-metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8',
      )
    }
    return skillDir
  }

  async function createSkillsetCache(
    skillsetId: string,
    index: SkillsetIndex,
    skillFiles?: Record<string, string>,
  ): Promise<string> {
    const repoDir = path.join(testDir, 'skillset-cache', skillsetId)
    await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true })
    await fs.promises.writeFile(
      path.join(repoDir, 'index.json'),
      JSON.stringify(index, null, 2),
      'utf-8',
    )
    if (skillFiles) {
      for (const [filePath, content] of Object.entries(skillFiles)) {
        const fullPath = path.join(repoDir, filePath)
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
        await fs.promises.writeFile(fullPath, content, 'utf-8')
      }
    }
    return repoDir
  }

  function buildMetadata(overrides: Partial<InstalledSkillMetadata> = {}): InstalledSkillMetadata {
    return {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/skills',
      skillName: 'Test Skill',
      skillPath: 'skills/test-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: contentHash('# Test Skill\nOriginal content'),
      ...overrides,
    }
  }

  function buildSkillsetConfig(overrides: Partial<SkillsetConfig> = {}): SkillsetConfig {
    return {
      id: 'test-skillset',
      url: 'https://github.com/TestOrg/skills',
      name: 'Test Skillset',
      description: 'A test skillset',
      addedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  function buildIndex(overrides: Partial<SkillsetIndex> = {}): SkillsetIndex {
    return {
      skillset_name: 'Test Skillset',
      description: 'A test skillset',
      version: '1.0.0',
      skills: [],
      ...overrides,
    }
  }

  function metadataPath(agentSlug: string, skillDirName: string): string {
    return path.join(
      testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills',
      skillDirName, '.skillset-metadata.json',
    )
  }

  async function readMetadata(agentSlug: string, skillDirName: string): Promise<InstalledSkillMetadata> {
    return JSON.parse(await fs.promises.readFile(metadataPath(agentSlug, skillDirName), 'utf-8'))
  }

  const SKILL_MD_PLAIN = `# Test Skill\nSome instructions for the agent.`

  function mockExecFileAsNoOp() {
    mockExecFile.mockReturnValue({ stdout: '', stderr: '' })
  }

  function setupPublishMocks() {
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        return { stdout: 'TestOrg/skills\n', stderr: '' }
      }
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') {
        return { stdout: 'testuser\n', stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return { stdout: 'https://github.com/TestOrg/skills/pull/99\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  }

  // ============================================================================
  // Group 1: Status Detection (getAgentSkillsWithStatus)
  // ============================================================================

  describe('getAgentSkillsWithStatus', () => {
    it('returns empty array when skills directory does not exist', async () => {
      const result = await getAgentSkillsWithStatus('nonexistent-agent', [])
      expect(result).toEqual([])
    })

    it('returns local type for skill with no metadata', async () => {
      await createSkillDir('test-agent', 'my-cool-skill', SKILL_MD_PLAIN)

      const result = await getAgentSkillsWithStatus('test-agent', [])

      expect(result).toHaveLength(1)
      expect(result[0].status).toEqual({ type: 'local' })
      expect(result[0].name).toBe('My Cool Skill')
      expect(result[0].path).toBe('my-cool-skill')
    })

    it('returns up_to_date when content matches and versions match', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({ originalContentHash: contentHash(skillContent) })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index)

      const result = await getAgentSkillsWithStatus('test-agent', [config])

      expect(result).toHaveLength(1)
      expect(result[0].status).toEqual({
        type: 'up_to_date',
        skillsetId: 'test-skillset',
        skillsetName: 'Test Skillset',
      })
    })

    it('returns update_available when cache has different version', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({ originalContentHash: contentHash(skillContent) })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '2.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index)

      const result = await getAgentSkillsWithStatus('test-agent', [config])

      expect(result).toHaveLength(1)
      expect(result[0].status).toEqual({
        type: 'update_available',
        skillsetId: 'test-skillset',
        skillsetName: 'Test Skillset',
        latestVersion: '2.0.0',
      })
    })

    it('returns locally_modified when content hash differs from original', async () => {
      const originalContent = '# Test Skill\nOriginal content'
      const modifiedContent = '# Test Skill\nModified content'
      const meta = buildMetadata({ originalContentHash: contentHash(originalContent) })
      const config = buildSkillsetConfig()

      await createSkillDir('test-agent', 'test-skill', modifiedContent, meta)
      await createSkillsetCache(config.id, buildIndex())

      const result = await getAgentSkillsWithStatus('test-agent', [config])

      expect(result).toHaveLength(1)
      expect(result[0].status.type).toBe('locally_modified')
    })

    it('returns locally_modified with openPrUrl when content differs and PR is open', async () => {
      const originalContent = '# Test Skill\nOriginal content'
      const modifiedContent = '# Test Skill\nModified content'
      const prUrl = 'https://github.com/TestOrg/skills/pull/42'
      const meta = buildMetadata({
        originalContentHash: contentHash(originalContent),
        openPrUrl: prUrl,
      })
      const config = buildSkillsetConfig()

      await createSkillDir('test-agent', 'test-skill', modifiedContent, meta)
      await createSkillsetCache(config.id, buildIndex())

      const result = await getAgentSkillsWithStatus('test-agent', [config])

      expect(result).toHaveLength(1)
      expect(result[0].status).toEqual({
        type: 'locally_modified',
        skillsetId: 'test-skillset',
        skillsetName: 'Test Skillset',
        openPrUrl: prUrl,
      })
    })

    it('returns locally_modified when content matches but openPrUrl is set (published, awaiting merge)', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const prUrl = 'https://github.com/TestOrg/skills/pull/42'
      const meta = buildMetadata({
        originalContentHash: contentHash(skillContent),
        openPrUrl: prUrl,
      })
      const config = buildSkillsetConfig()

      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, buildIndex())

      const result = await getAgentSkillsWithStatus('test-agent', [config])

      expect(result).toHaveLength(1)
      expect(result[0].status).toEqual({
        type: 'locally_modified',
        skillsetId: 'test-skillset',
        skillsetName: 'Test Skillset',
        openPrUrl: prUrl,
      })
    })

    it('returns results sorted alphabetically by name', async () => {
      await createSkillDir('test-agent', 'zebra-skill', SKILL_MD_PLAIN)
      await createSkillDir('test-agent', 'alpha-skill', SKILL_MD_PLAIN)
      await createSkillDir('test-agent', 'middle-skill', SKILL_MD_PLAIN)

      const result = await getAgentSkillsWithStatus('test-agent', [])

      expect(result.map((s) => s.name)).toEqual([
        'Alpha Skill',
        'Middle Skill',
        'Zebra Skill',
      ])
    })

    it('parses description from SKILL.md frontmatter', async () => {
      const skillMd = `---
description: This skill does something useful
---

# My Skill
Instructions here`
      await createSkillDir('test-agent', 'described-skill', skillMd)

      const result = await getAgentSkillsWithStatus('test-agent', [])

      expect(result[0].description).toBe('This skill does something useful')
    })

    it('returns default description when no frontmatter', async () => {
      await createSkillDir('test-agent', 'plain-skill', '# Plain\nNo frontmatter')

      const result = await getAgentSkillsWithStatus('test-agent', [])

      expect(result[0].description).toBe('No description provided')
    })
  })

  // ============================================================================
  // Group 2: Reconciliation (refreshAgentSkills)
  // ============================================================================

  describe('refreshAgentSkills', () => {
    beforeEach(() => {
      mockExecFileAsNoOp()
    })

    it('clears openPrUrl when published skill PR has been merged', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({
        originalContentHash: contentHash(skillContent),
        openPrUrl: 'https://github.com/TestOrg/skills/pull/42',
      })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index, {
        [meta.skillPath]: skillContent,
      })

      await refreshAgentSkills('test-agent', [config])

      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.openPrUrl).toBeUndefined()
    })

    it('keeps openPrUrl when published skill PR is not yet merged', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const prUrl = 'https://github.com/TestOrg/skills/pull/42'
      const meta = buildMetadata({
        originalContentHash: contentHash(skillContent),
        openPrUrl: prUrl,
      })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      // Cache has different content (PR not merged)
      await createSkillsetCache(config.id, index, {
        [meta.skillPath]: '# Test Skill\nOld upstream content',
      })

      await refreshAgentSkills('test-agent', [config])

      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.openPrUrl).toBe(prUrl)
    })

    it('updates metadata when locally modified changes are merged upstream', async () => {
      const originalContent = '# Test Skill\nOriginal content'
      const modifiedContent = '# Test Skill\nModified content'
      const meta = buildMetadata({
        originalContentHash: contentHash(originalContent),
      })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.1.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', modifiedContent, meta)
      // Cache matches modified content (changes merged upstream)
      await createSkillsetCache(config.id, index, {
        [meta.skillPath]: modifiedContent,
      })

      await refreshAgentSkills('test-agent', [config])

      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.originalContentHash).toBe(contentHash(modifiedContent))
      expect(updated.openPrUrl).toBeUndefined()

      // .skillset-original.md also updated
      const originalPath = path.join(
        testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills',
        'test-skill', '.skillset-original.md',
      )
      const storedOriginal = await fs.promises.readFile(originalPath, 'utf-8')
      expect(storedOriginal).toBe(modifiedContent)
    })

    it('does not modify metadata when locally modified and cache does not match', async () => {
      const originalContent = '# Test Skill\nOriginal content'
      const modifiedContent = '# Test Skill\nModified content'
      const originalHash = contentHash(originalContent)
      const meta = buildMetadata({ originalContentHash: originalHash })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', modifiedContent, meta)
      // Cache still has original content (no merge)
      await createSkillsetCache(config.id, index, {
        [meta.skillPath]: originalContent,
      })

      await refreshAgentSkills('test-agent', [config])

      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.originalContentHash).toBe(originalHash)
    })
  })

  // ============================================================================
  // Git Not Installed Detection
  // ============================================================================

  describe('validateSkillsetUrl', () => {
    it('throws helpful error with install link when git is not installed', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === 'git') {
          throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
        }
        return { stdout: '', stderr: '' }
      })

      await expect(
        validateSkillsetUrl('https://github.com/TestOrg/skills'),
      ).rejects.toThrow(/git is not installed/i)

      await expect(
        validateSkillsetUrl('https://github.com/TestOrg/skills'),
      ).rejects.toThrow(/git-scm\.com/)
    })

    it('throws helpful error with SSH link when git clone fails due to auth', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === '--version') {
          return { stdout: 'git version 2.40.0', stderr: '' }
        }
        if (cmd === 'git' && args[0] === 'clone') {
          throw new Error("fatal: repository 'https://github.com/Private/repo' not found")
        }
        return { stdout: '', stderr: '' }
      })

      await expect(
        validateSkillsetUrl('https://github.com/Private/repo'),
      ).rejects.toThrow(/could not access repository/i)

      await expect(
        validateSkillsetUrl('https://github.com/Private/repo'),
      ).rejects.toThrow(/ssh/)
    })
  })

  // ============================================================================
  // Group 3: Naming Conflict (publishSkillToSkillset)
  // ============================================================================

  describe('publishSkillToSkillset - naming conflict', () => {
    beforeEach(() => {
      setupPublishMocks()
    })

    it('throws error when a skill already exists at the same path in index.json', async () => {
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'existing-skill', SKILL_MD_PLAIN)

      const index = buildIndex({
        skills: [{
          name: 'Existing Skill',
          path: 'skills/existing-skill/SKILL.md',
          description: 'Already exists',
          version: '1.0.0',
        }],
      })
      await createSkillsetCache(config.id, index)

      await expect(
        publishSkillToSkillset('test-agent', 'existing-skill', config, {
          title: 'Add existing-skill',
          body: 'Adding skill',
        }),
      ).rejects.toThrow(/already exists/)
    })

    it('succeeds and returns PR URL when no naming conflict', async () => {
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'new-skill', SKILL_MD_PLAIN)

      const index = buildIndex({ skills: [] })
      await createSkillsetCache(config.id, index)

      const result = await publishSkillToSkillset(
        'test-agent', 'new-skill', config, {
          title: 'Add new-skill',
          body: 'Adding new skill',
        },
      )

      expect(result.prUrl).toBe('https://github.com/TestOrg/skills/pull/99')
    })

    it('writes metadata and original content after successful publish', async () => {
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'new-skill', SKILL_MD_PLAIN)
      await createSkillsetCache(config.id, buildIndex({ skills: [] }))

      await publishSkillToSkillset('test-agent', 'new-skill', config, {
        title: 'Add new-skill',
        body: 'Adding new skill',
      })

      const meta = await readMetadata('test-agent', 'new-skill')
      expect(meta.skillsetId).toBe(config.id)
      expect(meta.openPrUrl).toBe('https://github.com/TestOrg/skills/pull/99')
      expect(meta.originalContentHash).toBe(contentHash(SKILL_MD_PLAIN))

      const originalPath = path.join(
        testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills',
        'new-skill', '.skillset-original.md',
      )
      const storedOriginal = await fs.promises.readFile(originalPath, 'utf-8')
      expect(storedOriginal).toBe(SKILL_MD_PLAIN)
    })
  })

  // ============================================================================
  // Group 4: getSkillPublishInfo / generatePublishSuggestions fallback
  // ============================================================================

  describe('getSkillPublishInfo', () => {
    const skillsetConfig = buildSkillsetConfig()

    it('throws when skill has metadata (already belongs to a skillset)', async () => {
      const meta = buildMetadata()
      await createSkillDir('test-agent', 'tracked-skill', SKILL_MD_PLAIN, meta)

      await expect(
        getSkillPublishInfo('test-agent', 'tracked-skill', skillsetConfig),
      ).rejects.toThrow(/already belongs to a skillset/)
    })

    it('throws when gh CLI is not installed', async () => {
      await createSkillDir('test-agent', 'local-skill', SKILL_MD_PLAIN)

      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === '--version') {
          throw new Error('command not found: gh')
        }
        return { stdout: '', stderr: '' }
      })

      await expect(
        getSkillPublishInfo('test-agent', 'local-skill', skillsetConfig),
      ).rejects.toThrow(/not installed.*cli\.github\.com/is)
    })

    it('throws when gh CLI is not authenticated', async () => {
      await createSkillDir('test-agent', 'local-skill', SKILL_MD_PLAIN)

      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === '--version') {
          return { stdout: 'gh version 2.40.0', stderr: '' }
        }
        if (cmd === 'gh' && args[0] === 'auth') {
          throw new Error('not authenticated')
        }
        return { stdout: '', stderr: '' }
      })

      await expect(
        getSkillPublishInfo('test-agent', 'local-skill', skillsetConfig),
      ).rejects.toThrow(/not authenticated.*gh auth login/is)
    })

    it('returns fallback suggestions when no API key is configured', async () => {
      await createSkillDir('test-agent', 'local-skill', SKILL_MD_PLAIN)
      mockExecFileAsNoOp()
      mockGetApiKey.mockReturnValue(undefined)

      const result = await getSkillPublishInfo('test-agent', 'local-skill', skillsetConfig)

      expect(result.suggestedTitle).toBe('Add Local Skill skill')
      expect(result.suggestedBody).toContain('Local Skill')
      expect(result.suggestedVersion).toBe('1.0.0')
      expect(result.skillsetName).toBe('Test Skillset')
    })

    it('returns fallback suggestions when API call fails', async () => {
      await createSkillDir('test-agent', 'local-skill', SKILL_MD_PLAIN)
      mockExecFileAsNoOp()
      mockGetApiKey.mockReturnValue('sk-test-key')
      mockAnthropicCreate.mockRejectedValue(new Error('API error'))

      const result = await getSkillPublishInfo('test-agent', 'local-skill', skillsetConfig)

      expect(result.suggestedTitle).toBe('Add Local Skill skill')
    })

    it('returns AI-generated suggestions when API call succeeds', async () => {
      await createSkillDir('test-agent', 'local-skill', SKILL_MD_PLAIN)
      mockExecFileAsNoOp()
      mockGetApiKey.mockReturnValue('sk-test-key')
      mockAnthropicCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            title: 'Add local skill for agent management',
            body: 'Comprehensive agent management capabilities.',
            version: '1.0.0',
          }),
        }],
      })

      const result = await getSkillPublishInfo('test-agent', 'local-skill', skillsetConfig)

      expect(result.suggestedTitle).toBe('Add local skill for agent management')
      expect(result.suggestedBody).toBe('Comprehensive agent management capabilities.')
      expect(result.suggestedVersion).toBe('1.0.0')
    })

    it('uses version from frontmatter when available', async () => {
      const skillMd = `---
description: A versioned skill
metadata:
  version: "2.5.0"
---

# Versioned Skill`
      await createSkillDir('test-agent', 'versioned-skill', skillMd)
      mockExecFileAsNoOp()
      mockGetApiKey.mockReturnValue(undefined)

      const result = await getSkillPublishInfo('test-agent', 'versioned-skill', skillsetConfig)

      expect(result.suggestedVersion).toBe('2.5.0')
    })
  })

  // ============================================================================
  // Group 5: Frontmatter Parsing Helpers
  // ============================================================================

  describe('parseSkillFrontmatter', () => {
    it('returns empty object when no frontmatter', () => {
      expect(parseSkillFrontmatter('# Just markdown\nNo frontmatter.')).toEqual({})
    })

    it('returns empty object when frontmatter has no metadata section', () => {
      const content = `---
description: A skill
---

# Skill`
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('parses version from metadata section', () => {
      const content = `---
description: A skill
metadata:
  version: "1.2.3"
---

# Skill`
      expect(parseSkillFrontmatter(content).version).toBe('1.2.3')
    })

    it('parses required_env_vars from metadata section', () => {
      const content = `---
metadata:
  version: "1.0.0"
  required_env_vars:
    - name: API_KEY
      description: The API key
    - name: SECRET
      description: Auth token
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.required_env_vars).toEqual([
        { name: 'API_KEY', description: 'The API key' },
        { name: 'SECRET', description: 'Auth token' },
      ])
    })

    it('returns empty object for invalid YAML', () => {
      const content = `---
  invalid: yaml: content: [broken
---

# Skill`
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('returns empty object when metadata has no version', () => {
      const content = `---
metadata:
  some_other_key: value
---

# Skill`
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('filters out invalid required_env_vars entries', () => {
      const content = `---
metadata:
  required_env_vars:
    - name: VALID
      description: Valid entry
    - just_a_string
    - name: ALSO_VALID
      description: Another valid
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.required_env_vars).toHaveLength(2)
      expect(result.required_env_vars![0].name).toBe('VALID')
      expect(result.required_env_vars![1].name).toBe('ALSO_VALID')
    })
  })

  describe('contentHash', () => {
    it('returns consistent hex string for same input', () => {
      expect(contentHash('hello world')).toBe(contentHash('hello world'))
    })

    it('returns different hashes for different inputs', () => {
      expect(contentHash('hello')).not.toBe(contentHash('world'))
    })

    it('returns 64-character hex string (SHA-256)', () => {
      expect(contentHash('test input')).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  describe('urlToSkillsetId', () => {
    it('converts HTTPS URL to deterministic ID', () => {
      expect(urlToSkillsetId('https://github.com/DatawizzAI/skills')).toBe(
        'github-com-datawizzai-skills',
      )
    })

    it('converts SSH URL to same ID as HTTPS', () => {
      const idSsh = urlToSkillsetId('git@github.com:DatawizzAI/skills.git')
      const idHttps = urlToSkillsetId('https://github.com/DatawizzAI/skills')
      expect(idSsh).toBe(idHttps)
    })

    it('strips .git suffix', () => {
      expect(urlToSkillsetId('https://github.com/Org/repo.git')).toBe(
        'github-com-org-repo',
      )
    })
  })
})
