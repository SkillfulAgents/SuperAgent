import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
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
  getSettings: vi.fn(() => ({
    apiKeys: mockGetApiKey() ? { anthropicApiKey: mockGetApiKey() } : {},
  })),
  getEffectiveModels: mockGetModels,
}))

// Bypass retry delays in tests
vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}))

const mockGetPlatformAuthStatus = vi.fn((_userId?: string) => ({ orgId: undefined as string | undefined }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAuthStatus: (...args: [string?]) => mockGetPlatformAuthStatus(...args),
  getPlatformAccessToken: vi.fn(() => undefined),
}))
// Skillset code paths read attribution from AsyncLocalStorage (set by
// the `Authenticated` middleware in production). These service-level
// tests skip the middleware, so individual tests that need attribution
// must wrap their work in `runWithRequestUser('local', ...)`.
import { runWithRequestUser } from '@shared/lib/attribution'
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: vi.fn(() => undefined),
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
  createSkillPR,
  getSkillPRInfo,
  getInstalledSkillMetadata,
  getSkillsetRepoDir,
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
    extraFiles?: Record<string, string>,
  ): Promise<string> {
    const skillDir = path.join(
      testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills', skillDirName,
    )
    await fs.promises.mkdir(skillDir, { recursive: true })
    await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8')
    if (extraFiles) {
      for (const [relativePath, content] of Object.entries(extraFiles)) {
        const fullPath = path.join(skillDir, relativePath)
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
        await fs.promises.writeFile(fullPath, content, 'utf-8')
      }
    }
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

  function hashTestSkillPackage(files: Record<string, string>): string {
    const hash = crypto.createHash('sha256')
    for (const relativePath of Object.keys(files).sort()) {
      hash.update(relativePath, 'utf-8')
      hash.update('\0', 'utf-8')
      hash.update(files[relativePath], 'utf-8')
      hash.update('\0', 'utf-8')
    }
    return hash.digest('hex')
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

    it('detects local modifications when a non-SKILL file changes', async () => {
      const skillPath = 'skills/multi-file/SKILL.md'
      const extraFiles = {
        'sync/helper.py': 'print("v1")\n',
      }
      const meta = buildMetadata({
        skillPath,
        skillName: 'Multi File Skill',
        originalContentHash: hashTestSkillPackage({
          'SKILL.md': SKILL_MD_PLAIN,
          ...extraFiles,
        }),
      })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: meta.skillName, path: skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'multi-file', SKILL_MD_PLAIN, meta, extraFiles)
      await createSkillsetCache(config.id, index, {
        [skillPath]: SKILL_MD_PLAIN,
        'skills/multi-file/sync/helper.py': 'print("v1")\n',
      })

      const before = await getAgentSkillsWithStatus('test-agent', [config])
      expect(before[0].status.type).toBe('up_to_date')

      await fs.promises.writeFile(
        path.join(testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills', 'multi-file', 'sync', 'helper.py'),
        'print("v2")\n',
        'utf-8',
      )

      const after = await getAgentSkillsWithStatus('test-agent', [config])
      expect(after[0].status.type).toBe('locally_modified')
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
        sourceLabel: 'Test Skillset',
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
        sourceLabel: 'Test Skillset',
        latestVersion: '2.0.0',
      })
    })

    it('returns update_available when remote content changed but version is same', async () => {
      const originalContent = '# Test Skill\nOriginal content'
      const updatedContent = '# Test Skill\nRemote updated content'
      const meta = buildMetadata({ originalContentHash: contentHash(originalContent) })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', originalContent, meta)
      // Cache has updated content but same version in index.json
      await createSkillsetCache(config.id, index, {
        [path.dirname(meta.skillPath) + '/SKILL.md']: updatedContent,
      })

      const result = await getAgentSkillsWithStatus('test-agent', [config])

      expect(result).toHaveLength(1)
      expect(result[0].status).toEqual({
        type: 'update_available',
        skillsetId: 'test-skillset',
        skillsetName: 'Test Skillset',
        sourceLabel: 'Test Skillset',
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
        sourceLabel: 'Test Skillset',
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
        sourceLabel: 'Test Skillset',
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
      expect(updated.originalContentHash).toBe(hashTestSkillPackage({ 'SKILL.md': modifiedContent }))
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

    it('platform: merged queue item clears pendingQueueItemId and adopts remote content', async () => {
      mockGetPlatformAuthStatus.mockReturnValue({ orgId: 'org_A' })
      const proxyBase = 'https://platform.example'
      const queueId = 'q-1'
      const modifiedContent = '# Test Skill\nModified locally'
      const mergedContent = '# Test Skill\nMerged remote'

      const meta = buildMetadata({
        provider: 'platform',
        providerData: { orgId: 'org_A', repoId: 'platform--repo' },
        openPrUrl: `platform:queue:${queueId}`,
        pendingQueueItemId: queueId,
        skillsetId: 'platform--repo--test',
        originalContentHash: contentHash('# Test Skill\nOriginal content'),
      })
      const config = buildSkillsetConfig({
        id: meta.skillsetId,
        provider: 'platform',
        providerData: { orgId: 'org_A', repoId: 'platform--repo' },
      })
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', modifiedContent, meta)
      await createSkillsetCache('platform--repo', index, { [meta.skillPath]: mergedContent })

      // Mock platform env + batched queue endpoint reporting merged.
      const platformAuthMod = await import('@shared/lib/services/platform-auth-service')
      vi.mocked(platformAuthMod.getPlatformAccessToken).mockReturnValue('plat_test_xx')
      const proxyMod = await import('@shared/lib/platform-auth/config')
      vi.mocked(proxyMod.getPlatformProxyBaseUrl).mockReturnValue(proxyBase)

      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/queue/batch')) {
          return { ok: true, status: 200, json: async () => ({ items: { [queueId]: { status: 'merged' } } }) }
        }
        if (url.includes('/git-url')) {
          return { ok: true, status: 200, json: async () => ({ url: 'https://platform.example/repo.git', defaultBranch: 'main' }) }
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
      }))

      await runWithRequestUser('local', () => refreshAgentSkills('test-agent', [config]))
      vi.unstubAllGlobals()

      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.pendingQueueItemId).toBeUndefined()
      expect(updated.openPrUrl).toBeUndefined()
      const onDiskSkill = await fs.promises.readFile(
        path.join(testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills', 'test-skill', 'SKILL.md'),
        'utf-8',
      )
      // Remote content was adopted (lazy / refresh path).
      expect(onDiskSkill).toBe(mergedContent)
    })

    it('platform: rejected queue item clears pendingQueueItemId without touching files', async () => {
      mockGetPlatformAuthStatus.mockReturnValue({ orgId: 'org_A' })
      const proxyBase = 'https://platform.example'
      const queueId = 'q-2'
      const localContent = '# Test Skill\nLocal modifications'

      const meta = buildMetadata({
        provider: 'platform',
        providerData: { orgId: 'org_A', repoId: 'platform--repo' },
        pendingQueueItemId: queueId,
        skillsetId: 'platform--repo--test',
        originalContentHash: contentHash('# Test Skill\nOriginal'),
      })
      const config = buildSkillsetConfig({
        id: meta.skillsetId,
        provider: 'platform',
        providerData: { orgId: 'org_A', repoId: 'platform--repo' },
      })
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })

      await createSkillDir('test-agent', 'test-skill', localContent, meta)
      await createSkillsetCache('platform--repo', index, { [meta.skillPath]: '# Test Skill\nOriginal' })

      const platformAuthMod = await import('@shared/lib/services/platform-auth-service')
      vi.mocked(platformAuthMod.getPlatformAccessToken).mockReturnValue('plat_test_xx')
      const proxyMod = await import('@shared/lib/platform-auth/config')
      vi.mocked(proxyMod.getPlatformProxyBaseUrl).mockReturnValue(proxyBase)

      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/queue/batch')) {
          return { ok: true, status: 200, json: async () => ({ items: { [queueId]: { status: 'rejected' } } }) }
        }
        if (url.includes('/git-url')) {
          return { ok: true, status: 200, json: async () => ({ url: 'https://platform.example/repo.git', defaultBranch: 'main' }) }
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
      }))

      await runWithRequestUser('local', () => refreshAgentSkills('test-agent', [config]))
      vi.unstubAllGlobals()

      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.pendingQueueItemId).toBeUndefined()
      // Rejection does not overwrite local content.
      const onDiskSkill = await fs.promises.readFile(
        path.join(testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills', 'test-skill', 'SKILL.md'),
        'utf-8',
      )
      expect(onDiskSkill).toBe(localContent)
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
      expect(meta.originalContentHash).toBe(hashTestSkillPackage({ 'SKILL.md': SKILL_MD_PLAIN }))

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

  describe('getSkillPRInfo', () => {
    it('uses package diff when only auxiliary files changed', async () => {
      const meta = buildMetadata({
        skillPath: 'skills/word-counter/SKILL.md',
        skillName: 'Word Counter',
      })
      await createSkillDir(
        'test-agent',
        'word-counter',
        SKILL_MD_PLAIN,
        meta,
        { 'sync/helper.py': 'print("new")\n' },
      )
      await fs.promises.writeFile(
        path.join(
          testDir,
          'agents',
          'test-agent',
          'workspace',
          '.claude',
          'skills',
          'word-counter',
          '.skillset-original.md',
        ),
        SKILL_MD_PLAIN,
        'utf-8',
      )
      await createSkillsetCache(meta.skillsetId, buildIndex(), {
        [meta.skillPath]: SKILL_MD_PLAIN,
        'skills/word-counter/sync/helper.py': 'print("old")\n',
      })
      mockExecFileAsNoOp()
      mockGetApiKey.mockReturnValue('sk-test-key')
      mockAnthropicCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            title: 'Update word counter helper logic',
            body: 'Refreshes the helper implementation for word counting.',
            version: '1.0.1',
          }),
        }],
      })

      const result = await getSkillPRInfo('test-agent', 'word-counter')

      expect(result.suggestedTitle).toBe('Update word counter helper logic')
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1)

      const requestPayload = mockAnthropicCreate.mock.calls[0]?.[0] as {
        messages?: Array<{ content?: string }>
      }
      expect(requestPayload.messages?.[0]?.content).toContain('Modified file: sync/helper.py')
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

  // ============================================================================
  // TIER 1 — Extensive Pure Function Tests
  // ============================================================================

  // --------------------------------------------------------------------------
  // urlToSkillsetId — URL normalization edge cases
  // --------------------------------------------------------------------------

  describe('urlToSkillsetId — extensive', () => {
    it('handles http:// (not https)', () => {
      expect(urlToSkillsetId('http://github.com/Org/repo')).toBe(
        'github-com-org-repo',
      )
    })

    it('lowercases the entire ID', () => {
      expect(urlToSkillsetId('https://GitHub.COM/MyOrg/MyRepo')).toBe(
        'github-com-myorg-myrepo',
      )
    })

    it('handles trailing slash on HTTPS URL (trailing dash gets stripped)', () => {
      // Trailing "/" becomes "-" after replacement, then /^-+|-+$/g strips it
      expect(urlToSkillsetId('https://github.com/Org/repo/')).toBe(
        'github-com-org-repo',
      )
    })

    it('strips leading/trailing dashes from result', () => {
      // A URL that starts with https:// and ends with .git
      const id = urlToSkillsetId('https://github.com/Org/repo.git')
      expect(id).not.toMatch(/^-/)
      expect(id).not.toMatch(/-$/)
    })

    it('handles SSH URL without .git suffix', () => {
      expect(urlToSkillsetId('git@github.com:Org/repo')).toBe(
        'github-com-org-repo',
      )
    })

    it('produces the same ID for https with and without .git', () => {
      const id1 = urlToSkillsetId('https://github.com/Org/repo')
      const id2 = urlToSkillsetId('https://github.com/Org/repo.git')
      expect(id1).toBe(id2)
    })

    it('produces the same ID for SSH and HTTPS of the same repo', () => {
      const idSsh = urlToSkillsetId('git@github.com:Org/repo.git')
      const idHttps = urlToSkillsetId('https://github.com/Org/repo')
      expect(idSsh).toBe(idHttps)
    })

    it('handles GitLab URLs', () => {
      expect(urlToSkillsetId('https://gitlab.com/my-group/my-project')).toBe(
        'gitlab-com-my-group-my-project',
      )
    })

    it('handles Bitbucket URLs', () => {
      expect(urlToSkillsetId('https://bitbucket.org/team/repo')).toBe(
        'bitbucket-org-team-repo',
      )
    })

    it('handles URLs with deep paths (more than org/repo)', () => {
      expect(urlToSkillsetId('https://github.com/Org/repo/tree/main')).toBe(
        'github-com-org-repo-tree-main',
      )
    })

    it('replaces special characters with dashes', () => {
      // The regex [^a-zA-Z0-9/]+ becomes dashes
      expect(urlToSkillsetId('https://github.com/my_org/my_repo')).toBe(
        'github-com-my-org-my-repo',
      )
    })

    it('handles URL with query parameters', () => {
      const id = urlToSkillsetId('https://github.com/Org/repo?tab=code')
      // ? and = are not alphanumeric, so they become dashes
      expect(id).toBe('github-com-org-repo-tab-code')
    })

    it('handles URL with fragments', () => {
      const id = urlToSkillsetId('https://github.com/Org/repo#readme')
      expect(id).toBe('github-com-org-repo-readme')
    })

    it('handles empty string', () => {
      expect(urlToSkillsetId('')).toBe('')
    })

    it('handles plain string (non-URL)', () => {
      expect(urlToSkillsetId('just-a-name')).toBe('just-a-name')
    })

    it('handles string with only special characters', () => {
      const id = urlToSkillsetId('!@#$%^&*()')
      // All replaced with dashes, then leading/trailing dashes stripped
      expect(id).not.toMatch(/^-/)
      expect(id).not.toMatch(/-$/)
    })

    it('collapses consecutive special characters into a single dash', () => {
      // The regex [^a-zA-Z0-9/]+ uses + so "___" becomes single "-"
      expect(urlToSkillsetId('https://github.com/org___repo')).toBe(
        'github-com-org-repo',
      )
    })

    it('handles SSH URL with custom port notation', () => {
      // git@host:port/path format — colon becomes /
      const id = urlToSkillsetId('git@gitlab.example.com:2222/group/project.git')
      expect(id).toBe('gitlab-example-com-2222-group-project')
    })

    it('is deterministic (same input always gives same output)', () => {
      const url = 'https://github.com/StableOrg/stable-repo'
      const results = Array.from({ length: 10 }, () => urlToSkillsetId(url))
      expect(new Set(results).size).toBe(1)
    })
  })

  // --------------------------------------------------------------------------
  // parseSkillFrontmatter — extensive edge cases
  // --------------------------------------------------------------------------

  describe('parseSkillFrontmatter — extensive', () => {
    it('returns empty object for empty string', () => {
      expect(parseSkillFrontmatter('')).toEqual({})
    })

    it('returns empty object when content is just whitespace', () => {
      expect(parseSkillFrontmatter('   \n  \n  ')).toEqual({})
    })

    it('returns empty object when frontmatter has no closing ---', () => {
      const content = `---
metadata:
  version: "1.0.0"

# Skill content without closing frontmatter`
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('returns empty object for only the --- delimiters with nothing between', () => {
      const content = `---
---

# Skill`
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('returns metadata when file is only frontmatter (no body)', () => {
      const content = `---
metadata:
  version: "3.0.0"
---`
      expect(parseSkillFrontmatter(content).version).toBe('3.0.0')
    })

    it('parses the name field from frontmatter', () => {
      const content = `---
name: My Custom Skill
metadata:
  version: "1.0.0"
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.name).toBe('My Custom Skill')
      expect(result.version).toBe('1.0.0')
    })

    it('does not include name when it is not a string', () => {
      const content = `---
name: 42
metadata:
  version: "1.0.0"
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.name).toBeUndefined()
    })

    it('handles version as a number (converts to string)', () => {
      const content = `---
metadata:
  version: 2
---

# Skill`
      expect(parseSkillFrontmatter(content).version).toBe('2')
    })

    it('handles version as a float (converts to string)', () => {
      const content = `---
metadata:
  version: 1.5
---

# Skill`
      expect(parseSkillFrontmatter(content).version).toBe('1.5')
    })

    it('returns empty object when YAML parses to null', () => {
      const content = `---
~
---

# Skill`
      // YAML `~` is null
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('returns empty object when YAML parses to a scalar (not object)', () => {
      const content = `---
just a string
---

# Skill`
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('handles metadata with empty required_env_vars array', () => {
      const content = `---
metadata:
  version: "1.0.0"
  required_env_vars: []
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.version).toBe('1.0.0')
      expect(result.required_env_vars).toEqual([])
    })

    it('handles required_env_vars entry with missing description', () => {
      const content = `---
metadata:
  version: "1.0.0"
  required_env_vars:
    - name: MY_VAR
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.required_env_vars).toEqual([
        { name: 'MY_VAR', description: '' },
      ])
    })

    it('filters out null entries in required_env_vars', () => {
      const content = `---
metadata:
  required_env_vars:
    - name: VALID
      description: Good
    -
    - name: ALSO_VALID
      description: Also good
---

# Skill`
      const result = parseSkillFrontmatter(content)
      // The null entry should be filtered out (falsy check)
      expect(result.required_env_vars).toHaveLength(2)
    })

    it('filters out entries without name property in required_env_vars', () => {
      const content = `---
metadata:
  required_env_vars:
    - description: Only description, no name
    - name: HAS_NAME
      description: Has both
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.required_env_vars).toHaveLength(1)
      expect(result.required_env_vars![0].name).toBe('HAS_NAME')
    })

    it('converts non-string name/description to strings in required_env_vars', () => {
      const content = `---
metadata:
  required_env_vars:
    - name: 123
      description: true
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result.required_env_vars![0].name).toBe('123')
      expect(result.required_env_vars![0].description).toBe('true')
    })

    it('does not return version when metadata section exists but has no version key', () => {
      const content = `---
metadata:
  author: someone
  tags:
    - test
---

# Skill`
      const result = parseSkillFrontmatter(content)
      expect(result).toEqual({})
    })

    it('returns version when version is empty string', () => {
      const content = `---
metadata:
  version: ""
---

# Skill`
      expect(parseSkillFrontmatter(content).version).toBe('')
    })

    it('handles frontmatter with extra whitespace around delimiters', () => {
      const content = `---
metadata:
  version: "1.0.0"
---

# Skill`
      // The regex uses /^---\s*\n/ so "---   \n" should match
      expect(parseSkillFrontmatter(content).version).toBe('1.0.0')
    })

    it('does not parse --- that appears mid-file (not at start)', () => {
      const content = `# Skill

---
metadata:
  version: "1.0.0"
---`
      // Frontmatter must be at the very start (^---)
      expect(parseSkillFrontmatter(content)).toEqual({})
    })

    it('handles complex nested metadata with extra fields ignored', () => {
      const content = `---
name: Complex Skill
description: A complex skill
metadata:
  version: "2.0.0"
  author: test
  tags:
    - ai
    - automation
  required_env_vars:
    - name: API_KEY
      description: Main API key
---

# Complex Skill
Instructions here.`
      const result = parseSkillFrontmatter(content)
      expect(result.name).toBe('Complex Skill')
      expect(result.version).toBe('2.0.0')
      expect(result.required_env_vars).toEqual([
        { name: 'API_KEY', description: 'Main API key' },
      ])
    })

    it('handles version: 0 (falsy but defined)', () => {
      const content = `---
metadata:
  version: 0
---

# Skill`
      // version is 0. Since `metadata.version !== undefined`, it should be stringified
      expect(parseSkillFrontmatter(content).version).toBe('0')
    })

    it('handles required_env_vars that is not an array (e.g. object)', () => {
      const content = `---
metadata:
  version: "1.0.0"
  required_env_vars:
    API_KEY: some key
---

# Skill`
      const result = parseSkillFrontmatter(content)
      // Array.isArray check fails, so required_env_vars not set
      expect(result.version).toBe('1.0.0')
      expect(result.required_env_vars).toBeUndefined()
    })
  })

  // --------------------------------------------------------------------------
  // contentHash — extensive tests
  // --------------------------------------------------------------------------

  describe('contentHash — extensive', () => {
    it('returns the known SHA-256 for empty string', () => {
      // SHA-256 of empty string is well-known
      expect(contentHash('')).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      )
    })

    it('is case-sensitive', () => {
      expect(contentHash('Hello')).not.toBe(contentHash('hello'))
    })

    it('is whitespace-sensitive', () => {
      expect(contentHash('hello ')).not.toBe(contentHash('hello'))
      expect(contentHash(' hello')).not.toBe(contentHash('hello'))
      expect(contentHash('hello\n')).not.toBe(contentHash('hello'))
    })

    it('handles multi-line content', () => {
      const multiline = 'line1\nline2\nline3'
      const hash = contentHash(multiline)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
      expect(hash).toBe(contentHash(multiline)) // consistent
    })

    it('handles unicode content', () => {
      const hash = contentHash('Hello World')
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('handles very long content', () => {
      const longContent = 'a'.repeat(100000)
      const hash = contentHash(longContent)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('different by a single character produces different hash', () => {
      expect(contentHash('abc')).not.toBe(contentHash('abd'))
    })

    it('produces unique hashes for structurally different SKILL.md content', () => {
      const content1 = '---\nmetadata:\n  version: "1.0.0"\n---\n# Skill A'
      const content2 = '---\nmetadata:\n  version: "1.0.1"\n---\n# Skill A'
      expect(contentHash(content1)).not.toBe(contentHash(content2))
    })
  })

  // --------------------------------------------------------------------------
  // sanitizeDirName — tested indirectly through exported functions
  // --------------------------------------------------------------------------

  describe('sanitizeDirName — indirect (via getInstalledSkillMetadata)', () => {
    it('rejects directory name with forward slash', async () => {
      await expect(
        getInstalledSkillMetadata('agent', 'some/path'),
      ).rejects.toThrow(/Invalid directory name/)
    })

    it('rejects directory name with backslash', async () => {
      await expect(
        getInstalledSkillMetadata('agent', 'some\\path'),
      ).rejects.toThrow(/Invalid directory name/)
    })

    it('rejects directory name with ..', async () => {
      await expect(
        getInstalledSkillMetadata('agent', '..'),
      ).rejects.toThrow(/Invalid directory name/)
    })

    it('rejects directory name with embedded ..', async () => {
      await expect(
        getInstalledSkillMetadata('agent', 'foo/../bar'),
      ).rejects.toThrow(/Invalid directory name/)
    })

    it('rejects empty string directory name', async () => {
      await expect(
        getInstalledSkillMetadata('agent', ''),
      ).rejects.toThrow(/Invalid directory name/)
    })

    it('allows normal kebab-case names', async () => {
      // Should not throw — just returns null since no metadata file exists
      const result = await getInstalledSkillMetadata('agent', 'valid-skill-name')
      expect(result).toBeNull()
    })

    it('allows names with dots (not ..)', async () => {
      const result = await getInstalledSkillMetadata('agent', 'skill.v2')
      expect(result).toBeNull()
    })

    it('allows names with hyphens and numbers', async () => {
      const result = await getInstalledSkillMetadata('agent', 'my-skill-123')
      expect(result).toBeNull()
    })

    it('allows single character names', async () => {
      const result = await getInstalledSkillMetadata('agent', 'a')
      expect(result).toBeNull()
    })
  })

  // --------------------------------------------------------------------------
  // getDisplayName — tested indirectly through getAgentSkillsWithStatus
  // --------------------------------------------------------------------------

  describe('getDisplayName — indirect (via getAgentSkillsWithStatus)', () => {
    it('converts single-word kebab to title case', async () => {
      await createSkillDir('test-agent', 'analytics', SKILL_MD_PLAIN)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].name).toBe('Analytics')
    })

    it('converts multi-word kebab-case to Title Case', async () => {
      await createSkillDir('test-agent', 'data-pipeline-builder', SKILL_MD_PLAIN)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].name).toBe('Data Pipeline Builder')
    })

    it('handles name with numbers', async () => {
      await createSkillDir('test-agent', 'gpt-4-helper', SKILL_MD_PLAIN)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].name).toBe('Gpt 4 Helper')
    })

    it('handles single character segments', async () => {
      await createSkillDir('test-agent', 'a-b-c', SKILL_MD_PLAIN)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].name).toBe('A B C')
    })

    it('prefers skillName from metadata over display name', async () => {
      const meta = buildMetadata({ skillName: 'Custom Skill Name' })
      await createSkillDir('test-agent', 'my-skill', SKILL_MD_PLAIN, meta)
      await createSkillsetCache(meta.skillsetId, buildIndex())
      const config = buildSkillsetConfig()

      const result = await getAgentSkillsWithStatus('test-agent', [config])
      expect(result[0].name).toBe('Custom Skill Name')
    })

    it('prefers name from frontmatter when no metadata', async () => {
      const skillMd = `---
name: Frontmatter Skill Name
---

# My Skill`
      await createSkillDir('test-agent', 'my-skill', skillMd)

      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].name).toBe('Frontmatter Skill Name')
    })

    it('falls back to display name when metadata has no skillName and no frontmatter name', async () => {
      await createSkillDir('test-agent', 'fallback-name', SKILL_MD_PLAIN)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].name).toBe('Fallback Name')
    })
  })

  // --------------------------------------------------------------------------
  // updateFrontmatterVersion — tested indirectly through createSkillPR
  // --------------------------------------------------------------------------

  describe('updateFrontmatterVersion — indirect (via createSkillPR)', () => {
    beforeEach(() => {
      setupPublishMocks()
    })

    it('updates existing version in frontmatter when newVersion is specified', async () => {
      const skillMd = `---
metadata:
  version: "1.0.0"
---

# Versioned Skill
Content here`
      const skillPath = 'skills/versioned-skill/SKILL.md'
      const meta = buildMetadata({
        originalContentHash: contentHash('original'),
        skillPath,
      })
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'versioned-skill', skillMd, meta)
      // Create cache with the skill directory so writeFile has a parent dir
      await createSkillsetCache(config.id, buildIndex(), {
        [skillPath]: 'placeholder',
      })

      await createSkillPR('test-agent', 'versioned-skill', {
        title: 'Update skill',
        body: 'Updated',
        newVersion: '2.0.0',
      })

      // The file written to the repo dir should have updated version
      const repoDir = getSkillsetRepoDir(config.id)
      const writtenContent = await fs.promises.readFile(
        path.join(repoDir, skillPath),
        'utf-8',
      )
      expect(writtenContent).toContain('version: 2.0.0')
      expect(writtenContent).not.toContain('version: "1.0.0"')
    })

    it('preserves content when no newVersion is specified', async () => {
      const skillMd = `---
metadata:
  version: "1.0.0"
---

# Skill
Content here`
      const skillPath = 'skills/no-update/SKILL.md'
      const meta = buildMetadata({
        originalContentHash: contentHash('original'),
        skillPath,
      })
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'no-update', skillMd, meta)
      await createSkillsetCache(config.id, buildIndex(), {
        [skillPath]: 'placeholder',
      })

      await createSkillPR('test-agent', 'no-update', {
        title: 'Update skill',
        body: 'Updated',
        // no newVersion
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const writtenContent = await fs.promises.readFile(
        path.join(repoDir, skillPath),
        'utf-8',
      )
      expect(writtenContent).toContain('version: "1.0.0"')
    })

    it('preserves body content after frontmatter when version is updated', async () => {
      const skillMd = `---
description: My skill
metadata:
  version: "1.0.0"
---

# My Skill
Detailed instructions go here.
Multiple lines of content.`
      const skillPath = 'skills/body-test/SKILL.md'
      const meta = buildMetadata({
        originalContentHash: contentHash('original'),
        skillPath,
      })
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'body-test', skillMd, meta)
      await createSkillsetCache(config.id, buildIndex(), {
        [skillPath]: 'placeholder',
      })

      await createSkillPR('test-agent', 'body-test', {
        title: 'Update',
        body: 'Updated',
        newVersion: '1.1.0',
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const writtenContent = await fs.promises.readFile(
        path.join(repoDir, skillPath),
        'utf-8',
      )
      expect(writtenContent).toContain('# My Skill')
      expect(writtenContent).toContain('Detailed instructions go here.')
      expect(writtenContent).toContain('Multiple lines of content.')
      expect(writtenContent).toContain('version: 1.1.0')
    })

    it('leaves content unchanged if no frontmatter exists and newVersion is set', async () => {
      const skillMd = `# No Frontmatter Skill
Just content, no frontmatter at all.`
      const skillPath = 'skills/no-fm/SKILL.md'
      const meta = buildMetadata({
        originalContentHash: contentHash('original'),
        skillPath,
      })
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'no-fm', skillMd, meta)
      await createSkillsetCache(config.id, buildIndex(), {
        [skillPath]: 'placeholder',
      })

      await createSkillPR('test-agent', 'no-fm', {
        title: 'Update',
        body: 'Updated',
        newVersion: '2.0.0',
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const writtenContent = await fs.promises.readFile(
        path.join(repoDir, skillPath),
        'utf-8',
      )
      // Content should be unchanged since there is no frontmatter to update
      expect(writtenContent).toBe(skillMd)
    })

    it('copies non-SKILL files into the PR branch', async () => {
      const skillPath = 'skills/multi-file/SKILL.md'
      const meta = buildMetadata({
        skillPath,
        skillName: 'Multi File Skill',
      })
      const config = buildSkillsetConfig()
      await createSkillDir(
        'test-agent',
        'multi-file',
        SKILL_MD_PLAIN,
        meta,
        { 'sync/run.py': 'print("ship it")\n' },
      )
      await createSkillsetCache(config.id, buildIndex(), {
        [skillPath]: SKILL_MD_PLAIN,
        'skills/multi-file/sync/run.py': 'print("old")\n',
      })

      await createSkillPR('test-agent', 'multi-file', {
        title: 'Update skill',
        body: 'Updated',
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const writtenAuxFile = await fs.promises.readFile(
        path.join(repoDir, 'skills', 'multi-file', 'sync', 'run.py'),
        'utf-8',
      )
      expect(writtenAuxFile).toBe('print("ship it")\n')
    })
  })

  // --------------------------------------------------------------------------
  // parseDescription — tested indirectly through getAgentSkillsWithStatus
  // --------------------------------------------------------------------------

  describe('parseDescription — indirect (via getAgentSkillsWithStatus)', () => {
    it('extracts description from frontmatter', async () => {
      const skillMd = `---
description: Analyzes customer data
---

# Analytics Skill`
      await createSkillDir('test-agent', 'analytics', skillMd)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].description).toBe('Analyzes customer data')
    })

    it('returns default when frontmatter has no description key', async () => {
      const skillMd = `---
metadata:
  version: "1.0.0"
---

# No Desc`
      await createSkillDir('test-agent', 'no-desc', skillMd)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].description).toBe('No description provided')
    })

    it('returns default when description is not a string', async () => {
      const skillMd = `---
description:
  nested: value
---

# Nested Desc`
      await createSkillDir('test-agent', 'nested-desc', skillMd)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].description).toBe('No description provided')
    })

    it('returns default when YAML is invalid', async () => {
      const skillMd = `---
  invalid: yaml: [broken
---

# Bad YAML`
      await createSkillDir('test-agent', 'bad-yaml', skillMd)
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].description).toBe('No description provided')
    })

    it('returns default for empty file content', async () => {
      // An empty SKILL.md means the directory gets skipped (no skillMdContent)
      // Let's test with minimal content (no frontmatter)
      await createSkillDir('test-agent', 'minimal', '# Minimal')
      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].description).toBe('No description provided')
    })
  })

  // --------------------------------------------------------------------------
  // getAgentSkillsWithStatus — additional edge cases
  // --------------------------------------------------------------------------

  describe('getAgentSkillsWithStatus — additional edge cases', () => {
    it('skips directories without SKILL.md', async () => {
      // Create a directory without SKILL.md
      const skillsDir = path.join(
        testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills', 'empty-dir',
      )
      await fs.promises.mkdir(skillsDir, { recursive: true })
      // No SKILL.md file

      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result).toEqual([])
    })

    it('skips non-directory entries', async () => {
      const skillsDir = path.join(
        testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills',
      )
      await fs.promises.mkdir(skillsDir, { recursive: true })
      // Create a file instead of a directory
      await fs.promises.writeFile(path.join(skillsDir, 'not-a-dir.txt'), 'content')

      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result).toEqual([])
    })

    it('returns up_to_date when skillset index has no matching skill entry (same version)', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({ originalContentHash: contentHash(skillContent) })
      const config = buildSkillsetConfig()
      // Index with NO skills — skill not found in index
      const index = buildIndex({ skills: [] })

      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index)

      const result = await getAgentSkillsWithStatus('test-agent', [config])
      // No matching skill entry means skillEntry is undefined, so no version mismatch => up_to_date
      expect(result[0].status.type).toBe('up_to_date')
    })

    it('treats orphan skills (no matching config) as local', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({
        originalContentHash: contentHash(skillContent),
        skillsetId: 'unknown-skillset',
      })
      // No config for this skillset, but we do have metadata pointing to it
      await createSkillDir('test-agent', 'orphan-skill', skillContent, meta)

      const result = await getAgentSkillsWithStatus('test-agent', [])
      expect(result[0].status).toEqual({
        type: 'local',
      })
    })

    // Access filtering removed: platform skillsets are cleaned up on org switch/disconnect
    // instead of being filtered at query time. See platform-auth-service.ts removePlatformSkillsets().

    it('handles multiple skills with mixed statuses', async () => {
      const originalContent = '# Test Skill\nOriginal content'
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [
          { name: 'Skill A', path: 'skills/skill-a/SKILL.md', description: 'A', version: '1.0.0' },
          { name: 'Skill B', path: 'skills/skill-b/SKILL.md', description: 'B', version: '2.0.0' },
        ],
      })

      // skill-a: up_to_date
      const metaA = buildMetadata({
        skillName: 'Skill A',
        skillPath: 'skills/skill-a/SKILL.md',
        originalContentHash: contentHash(originalContent),
        installedVersion: '1.0.0',
      })
      await createSkillDir('test-agent', 'skill-a', originalContent, metaA)

      // skill-b: update_available (installed 1.0.0, index has 2.0.0)
      const metaB = buildMetadata({
        skillName: 'Skill B',
        skillPath: 'skills/skill-b/SKILL.md',
        originalContentHash: contentHash(originalContent),
        installedVersion: '1.0.0',
      })
      await createSkillDir('test-agent', 'skill-b', originalContent, metaB)

      // skill-c: local (no metadata)
      await createSkillDir('test-agent', 'skill-c', SKILL_MD_PLAIN)

      await createSkillsetCache(config.id, index)

      const result = await getAgentSkillsWithStatus('test-agent', [config])
      expect(result).toHaveLength(3)

      const statusMap = new Map(result.map((s) => [s.name, s.status.type]))
      expect(statusMap.get('Skill A')).toBe('up_to_date')
      expect(statusMap.get('Skill B')).toBe('update_available')
      expect(statusMap.get('Skill C')).toBe('local')
    })
  })

  // --------------------------------------------------------------------------
  // getSkillsetRepoDir — simple path composition test
  // --------------------------------------------------------------------------

  describe('getSkillsetRepoDir', () => {
    it('returns path under skillset-cache in data dir', () => {
      const result = getSkillsetRepoDir('github-com-org-repo')
      expect(result).toBe(path.join(testDir, 'skillset-cache', 'github-com-org-repo'))
    })

    it('handles skillset IDs with dashes and numbers', () => {
      const result = getSkillsetRepoDir('gitlab-com-team-project-123')
      expect(result).toBe(path.join(testDir, 'skillset-cache', 'gitlab-com-team-project-123'))
    })
  })

  // --------------------------------------------------------------------------
  // getInstalledSkillMetadata — reads and parses metadata
  // --------------------------------------------------------------------------

  describe('getInstalledSkillMetadata', () => {
    it('returns null when metadata file does not exist', async () => {
      await createSkillDir('test-agent', 'no-meta', SKILL_MD_PLAIN)
      const result = await getInstalledSkillMetadata('test-agent', 'no-meta')
      expect(result).toBeNull()
    })

    it('returns parsed metadata when file exists', async () => {
      const meta = buildMetadata({ skillName: 'Parse Test Skill' })
      await createSkillDir('test-agent', 'meta-skill', SKILL_MD_PLAIN, meta)
      const result = await getInstalledSkillMetadata('test-agent', 'meta-skill')
      expect(result).not.toBeNull()
      expect(result!.skillName).toBe('Parse Test Skill')
      expect(result!.skillsetId).toBe('test-skillset')
      expect(result!.installedVersion).toBe('1.0.0')
    })

    it('returns null for invalid JSON metadata', async () => {
      const skillDir = path.join(
        testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills', 'bad-json',
      )
      await fs.promises.mkdir(skillDir, { recursive: true })
      await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD_PLAIN)
      await fs.promises.writeFile(
        path.join(skillDir, '.skillset-metadata.json'),
        'not valid json {{{',
        'utf-8',
      )

      const result = await getInstalledSkillMetadata('test-agent', 'bad-json')
      expect(result).toBeNull()
    })
  })

  // --------------------------------------------------------------------------
  // publishSkillToSkillset — version update through publish
  // --------------------------------------------------------------------------

  describe('publishSkillToSkillset — version handling', () => {
    beforeEach(() => {
      setupPublishMocks()
    })

    it('uses version from frontmatter when no newVersion specified', async () => {
      const skillMd = `---
description: A skill
metadata:
  version: "3.5.0"
---

# Versioned Skill`
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'ver-skill', skillMd)
      await createSkillsetCache(config.id, buildIndex({ skills: [] }))

      await publishSkillToSkillset('test-agent', 'ver-skill', config, {
        title: 'Add ver-skill',
        body: 'Adding',
      })

      // Read updated index.json to verify version
      const repoDir = getSkillsetRepoDir(config.id)
      const indexContent = JSON.parse(
        await fs.promises.readFile(path.join(repoDir, 'index.json'), 'utf-8'),
      )
      const entry = indexContent.skills.find(
        (s: { path: string }) => s.path === 'skills/ver-skill/SKILL.md',
      )
      expect(entry.version).toBe('3.5.0')
    })

    it('uses newVersion when specified, overriding frontmatter', async () => {
      const skillMd = `---
metadata:
  version: "1.0.0"
---

# Skill`
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'override-ver', skillMd)
      await createSkillsetCache(config.id, buildIndex({ skills: [] }))

      await publishSkillToSkillset('test-agent', 'override-ver', config, {
        title: 'Add skill',
        body: 'Adding',
        newVersion: '5.0.0',
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const indexContent = JSON.parse(
        await fs.promises.readFile(path.join(repoDir, 'index.json'), 'utf-8'),
      )
      const entry = indexContent.skills.find(
        (s: { path: string }) => s.path === 'skills/override-ver/SKILL.md',
      )
      expect(entry.version).toBe('5.0.0')
    })

    it('defaults to 1.0.0 when no frontmatter version and no newVersion', async () => {
      const config = buildSkillsetConfig()
      await createSkillDir('test-agent', 'default-ver', SKILL_MD_PLAIN)
      await createSkillsetCache(config.id, buildIndex({ skills: [] }))

      await publishSkillToSkillset('test-agent', 'default-ver', config, {
        title: 'Add skill',
        body: 'Adding',
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const indexContent = JSON.parse(
        await fs.promises.readFile(path.join(repoDir, 'index.json'), 'utf-8'),
      )
      const entry = indexContent.skills.find(
        (s: { path: string }) => s.path === 'skills/default-ver/SKILL.md',
      )
      expect(entry.version).toBe('1.0.0')
    })

    it('publishes non-SKILL files alongside the skill definition', async () => {
      const config = buildSkillsetConfig()
      await createSkillDir(
        'test-agent',
        'packaged-skill',
        SKILL_MD_PLAIN,
        undefined,
        { 'sync/helper.py': 'print("helper")\n' },
      )
      await createSkillsetCache(config.id, buildIndex({ skills: [] }))

      await publishSkillToSkillset('test-agent', 'packaged-skill', config, {
        title: 'Add skill',
        body: 'Adding',
      })

      const repoDir = getSkillsetRepoDir(config.id)
      const writtenAuxFile = await fs.promises.readFile(
        path.join(repoDir, 'skills', 'packaged-skill', 'sync', 'helper.py'),
        'utf-8',
      )
      expect(writtenAuxFile).toBe('print("helper")\n')
    })
  })
})
