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
    (cmd: string, args: string[], opts?: unknown) =>
      { stdout: string; stderr: string } | Promise<{ stdout: string; stderr: string }>
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
    Promise.resolve()
      .then(() => mockExecFile(...callArgs))
      .then((result) => {
        callback(null, result?.stdout ?? '', result?.stderr ?? '')
      })
      .catch((err) => {
        callback(err as Error)
      })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(execFileFn as any)[Symbol.for('nodejs.util.promisify.custom')] = async (
    ...args: unknown[]
  ) => {
    const callArgs = args as [string, string[], unknown?]
    const result = await mockExecFile(...callArgs)
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
  getModelCatalogSettings: () => ({}),
}))

// Bypass retry delays in tests
vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}))

const mockGetPlatformAuthStatus = vi.fn(
  (_userId?: string): { connected?: boolean; source?: 'settings' | 'env' | null; orgId: string | undefined } =>
    ({ orgId: undefined }),
)
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAuthStatus: (...args: [string?]) => mockGetPlatformAuthStatus(...args),
  getPlatformAccessToken: vi.fn(() => undefined),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: vi.fn(() => undefined),
}))

import {
  contentHash,
  parseSkillFrontmatter,
  urlToSkillsetId,
  getAgentSkillsWithStatus,
  refreshSkillset,
  refreshAgentSkills,
  publishSkillToSkillset,
  getSkillPublishInfo,
  validateSkillsetUrl,
  createSkillPR,
  getSkillPRInfo,
  getInstalledSkillMetadata,
  getSkillsetRepoDir,
  isCacheReady,
  isGitAvailable,
  deleteSkill,
  exportSkill,
  validateSkillZip,
  importSkillFromZip,
} from './skillset-service'
import { createZipBuffer, openZipFromBuffer } from '@shared/lib/utils/zip'

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
    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      // Resolve a default branch so gitPull exercises its real fetch/reset
      // path instead of bailing out on an unresolved origin/HEAD.
      if (cmd === 'git' && args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
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
      mockGetPlatformAuthStatus.mockReturnValue({ connected: true, source: 'settings', orgId: 'org_A' })
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

      await refreshAgentSkills('test-agent', [config])
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
      mockGetPlatformAuthStatus.mockReturnValue({ connected: true, source: 'settings', orgId: 'org_A' })
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

      await refreshAgentSkills('test-agent', [config])
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

    it('gitPull resolves origin/HEAD via set-head and refreshes via fetch+reset FETCH_HEAD', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({ originalContentHash: contentHash(skillContent) })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })
      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index, { [meta.skillPath]: skillContent })

      const calls: string[][] = []
      let setHeadDone = false
      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        if (cmd === 'git' && args[0] === 'symbolic-ref') {
          // Symref is missing until `set-head --auto` runs (shallow clone).
          if (!setHeadDone) {
            throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')
          }
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'set-head') {
          setHeadDone = true
          return { stdout: '', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })

      await expect(refreshAgentSkills('test-agent', [config])).resolves.toBeUndefined()

      const cmdline = calls.map((c) => c.join(' '))
      expect(cmdline).toContain('git remote set-head origin --auto')
      expect(cmdline).toContain('git checkout main')
      expect(cmdline).toContain('git fetch --depth 1 origin main')
      expect(cmdline).toContain('git reset --hard FETCH_HEAD')
      // No brittle hardcoded master fallback and no full-history reset by name.
      expect(cmdline).not.toContain('git checkout master')
      expect(cmdline.some((c) => c.startsWith('git reset --hard origin/'))).toBe(false)
    })

    it('coalesces concurrent refreshes for the same cache directory', async () => {
      const config = buildSkillsetConfig()
      const index = buildIndex()
      await createSkillsetCache(config.id, index)

      const ref = {
        skillsetId: config.id,
        skillsetUrl: config.url,
        provider: config.provider,
        providerData: config.providerData,
      }

      let setUrlCalls = 0
      let releaseSetUrl!: () => void
      let notifySetUrlStarted!: () => void
      const setUrlStarted = new Promise<void>((resolve) => {
        notifySetUrlStarted = resolve
      })
      const setUrlCanFinish = new Promise<void>((resolve) => {
        releaseSetUrl = resolve
      })

      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'set-url') {
          setUrlCalls += 1
          notifySetUrlStarted()
          return setUrlCanFinish.then(() => ({ stdout: '', stderr: '' }))
        }
        if (cmd === 'git' && args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })

      const firstRefresh = refreshSkillset(ref)
      await setUrlStarted
      const secondRefresh = refreshSkillset(ref)
      releaseSetUrl()

      await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([index, index])
      expect(setUrlCalls).toBe(1)

      await expect(refreshSkillset(ref)).resolves.toEqual(index)
      expect(setUrlCalls).toBe(2)
    })

    it('gitPull swallows expected drift errors from fetch+reset without throwing', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({ originalContentHash: contentHash(skillContent) })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })
      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index, { [meta.skillPath]: skillContent })

      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (cmd === 'git' && args[0] === 'fetch') {
          // The kind of benign drift seen on shallow single-branch caches.
          throw new Error("fatal: couldn't find remote ref main: no such ref was fetched")
        }
        return { stdout: '', stderr: '' }
      })

      // Refresh must not throw and metadata must remain intact (up-to-date).
      await expect(refreshAgentSkills('test-agent', [config])).resolves.toBeUndefined()
      const updated = await readMetadata('test-agent', 'test-skill')
      expect(updated.originalContentHash).toBe(hashTestSkillPackage({ 'SKILL.md': skillContent }))
    })

    it('gitPull reports unexpected fetch errors to Sentry', async () => {
      const skillContent = '# Test Skill\nOriginal content'
      const meta = buildMetadata({ originalContentHash: contentHash(skillContent) })
      const config = buildSkillsetConfig()
      const index = buildIndex({
        skills: [{ name: 'Test Skill', path: meta.skillPath, description: 'desc', version: '1.0.0' }],
      })
      await createSkillDir('test-agent', 'test-skill', skillContent, meta)
      await createSkillsetCache(config.id, index, { [meta.skillPath]: skillContent })

      mockExecFile.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
        }
        if (cmd === 'git' && args[0] === 'fetch') {
          throw new Error('fatal: unable to access remote: Connection timed out')
        }
        return { stdout: '', stderr: '' }
      })

      // Unexpected errors are surfaced (captured + rethrown) but refreshAgentSkills
      // catches per-skillset so the overall call still resolves.
      await expect(refreshAgentSkills('test-agent', [config])).resolves.toBeUndefined()
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
---

# Complex Skill
Instructions here.`
      const result = parseSkillFrontmatter(content)
      expect(result.name).toBe('Complex Skill')
      expect(result.version).toBe('2.0.0')
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

  // ==========================================================================
  // isCacheReady / isGitAvailable
  // ==========================================================================

  describe('isCacheReady', () => {
    it('returns true for git-based provider when .git exists', async () => {
      const repoDir = path.join(testDir, 'skillset-cache', 'git-test')
      await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true })
      expect(await isCacheReady(repoDir, 'github')).toBe(true)
    })

    it('returns false for git-based provider when .git is missing', async () => {
      const repoDir = path.join(testDir, 'skillset-cache', 'git-test-empty')
      await fs.promises.mkdir(repoDir, { recursive: true })
      expect(await isCacheReady(repoDir, 'github')).toBe(false)
    })

    it('delegates to provider.isCacheReady for non-git provider', async () => {
      const repoDir = path.join(testDir, 'skillset-cache', 'public-test')
      await fs.promises.mkdir(repoDir, { recursive: true })

      // No .git, but has the public provider's cache marker
      await fs.promises.writeFile(
        path.join(repoDir, '.skillset-cache-meta.json'),
        JSON.stringify({ provider: 'public', cachedAt: new Date().toISOString(), sourceUrl: 'test' }),
      )
      expect(await isCacheReady(repoDir, 'public')).toBe(true)
    })

    it('returns false for public provider when marker is missing', async () => {
      const repoDir = path.join(testDir, 'skillset-cache', 'public-empty')
      await fs.promises.mkdir(repoDir, { recursive: true })
      expect(await isCacheReady(repoDir, 'public')).toBe(false)
    })

    it('defaults to github provider when provider is undefined', async () => {
      const repoDir = path.join(testDir, 'skillset-cache', 'default-test')
      await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true })
      expect(await isCacheReady(repoDir, undefined)).toBe(true)
    })
  })

  describe('isGitAvailable', () => {
    it('returns true when git --version succeeds', async () => {
      mockExecFile.mockReturnValue({ stdout: 'git version 2.40.0', stderr: '' })
      expect(await isGitAvailable()).toBe(true)
    })

    it('returns false when git --version fails', async () => {
      mockExecFile.mockImplementation(() => { throw new Error('not found') })
      expect(await isGitAvailable()).toBe(false)
    })
  })

  // ==========================================================================
  // Skill ZIP Export / Import
  // ==========================================================================

  const MINIMAL_SKILL_MD = `---
name: Test Skill
metadata:
  version: "1.0.0"
---
# Test Skill

Do something useful.
`

  const SKILL_MD_NO_NAME = `---
metadata:
  version: "1.0.0"
---
# A Skill
`

  async function makeSkillZip(files: Record<string, string>): Promise<Buffer> {
    return createZipBuffer(files)
  }

  function makeSkillDir(agentSlug: string, skillDirName: string): string {
    const skillsDir = path.join(testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills', skillDirName)
    fs.mkdirSync(skillsDir, { recursive: true })
    return skillsDir
  }

  describe('exportSkill', () => {
    it('exports a single-file skill wrapped in its directory folder', async () => {
      const agentSlug = 'test-agent'
      const skillDir = makeSkillDir(agentSlug, 'my-skill')
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), MINIMAL_SKILL_MD)

      const { zipBuffer, skillName } = await exportSkill(agentSlug, 'my-skill')
      expect(zipBuffer).toBeInstanceOf(Buffer)
      expect(skillName).toBe('Test Skill')

      const reader = await openZipFromBuffer(zipBuffer)
      try {
        const fileNames = reader.entries.map(e => e.fileName)
        // Wrapper folder carries the skill's directory name inside the package.
        expect(fileNames).toContain('my-skill/SKILL.md')
        expect(reader.entries.length).toBe(1)
      } finally {
        reader.close()
      }
    })

    it('exports a multi-file skill under a single wrapper the importer strips', async () => {
      const agentSlug = 'test-agent'
      const skillDir = makeSkillDir(agentSlug, 'multi-skill')
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), MINIMAL_SKILL_MD)
      fs.writeFileSync(path.join(skillDir, 'helper.py'), 'print("hello")')
      fs.mkdirSync(path.join(skillDir, 'lib'))
      fs.writeFileSync(path.join(skillDir, 'lib', 'utils.py'), 'x = 1')

      const { zipBuffer } = await exportSkill(agentSlug, 'multi-skill')
      const reader = await openZipFromBuffer(zipBuffer)
      try {
        const fileNames = reader.entries.map(e => e.fileName).sort()
        expect(fileNames).toEqual([
          'multi-skill/SKILL.md',
          'multi-skill/helper.py',
          expect.stringContaining('utils.py'),
        ])
      } finally {
        reader.close()
      }
      // The wrapper is exactly what validateSkillZip detects and strips.
      const validation = await validateSkillZip(zipBuffer)
      expect(validation.valid).toBe(true)
      expect(validation.stripPrefix).toBe('multi-skill/')
    })

    it('excludes .skillset-metadata.json and .skillset-original.md', async () => {
      const agentSlug = 'test-agent'
      const skillDir = makeSkillDir(agentSlug, 'meta-skill')
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), MINIMAL_SKILL_MD)
      fs.writeFileSync(path.join(skillDir, '.skillset-metadata.json'), '{}')
      fs.writeFileSync(path.join(skillDir, '.skillset-original.md'), '# original')

      const { zipBuffer } = await exportSkill(agentSlug, 'meta-skill')
      const reader = await openZipFromBuffer(zipBuffer)
      try {
        const fileNames = reader.entries.map(e => e.fileName)
        expect(fileNames).toContain('meta-skill/SKILL.md')
        expect(fileNames.some(f => f.endsWith('.skillset-metadata.json'))).toBe(false)
        expect(fileNames.some(f => f.endsWith('.skillset-original.md'))).toBe(false)
      } finally {
        reader.close()
      }
    })

    it('throws when skill directory does not exist', async () => {
      await expect(exportSkill('test-agent', 'nonexistent')).rejects.toThrow('Skill directory not found')
    })

    it('throws when SKILL.md is missing', async () => {
      const agentSlug = 'test-agent'
      const skillDir = makeSkillDir(agentSlug, 'no-skillmd')
      fs.writeFileSync(path.join(skillDir, 'helper.py'), 'x = 1')

      await expect(exportSkill(agentSlug, 'no-skillmd')).rejects.toThrow('SKILL.md not found')
    })

    it('rejects path traversal in skillDirName', async () => {
      await expect(exportSkill('test-agent', '../etc')).rejects.toThrow('Invalid directory name')
    })
  })

  describe('deleteSkill', () => {
    it('removes a skill directory recursively', async () => {
      const agentSlug = 'test-agent'
      const skillDir = makeSkillDir(agentSlug, 'delete-me')
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), MINIMAL_SKILL_MD)
      fs.mkdirSync(path.join(skillDir, 'lib'))
      fs.writeFileSync(path.join(skillDir, 'lib', 'helper.py'), 'print("hello")')

      await deleteSkill(agentSlug, 'delete-me')

      expect(fs.existsSync(skillDir)).toBe(false)
    })

    it('throws when skill directory does not exist', async () => {
      await expect(deleteSkill('test-agent', 'missing-skill')).rejects.toThrow('Skill directory not found')
    })

    it('rejects path traversal in skillDirName', async () => {
      await expect(deleteSkill('test-agent', '../etc')).rejects.toThrow('Invalid directory name')
    })
  })

  describe('validateSkillZip', () => {
    it('accepts a valid zip with SKILL.md and extracts name', async () => {
      const buf = await makeSkillZip({ 'SKILL.md': MINIMAL_SKILL_MD })
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(true)
      expect(result.skillName).toBe('Test Skill')
      expect(result.fileCount).toBe(1)
      expect(result.stripPrefix).toBe('')
    })

    it('returns skillName undefined when frontmatter has no name and there is no wrapper', async () => {
      const buf = await makeSkillZip({ 'SKILL.md': SKILL_MD_NO_NAME })
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(true)
      expect(result.skillName).toBeUndefined()
    })

    it('falls back to the wrapper directory name when frontmatter has no name', async () => {
      const buf = await makeSkillZip({
        'reporting-tools/SKILL.md': SKILL_MD_NO_NAME,
        'reporting-tools/helper.py': 'x = 1',
      })
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(true)
      expect(result.skillName).toBe('reporting-tools')
    })

    it('prefers the frontmatter name over the wrapper directory name', async () => {
      const buf = await makeSkillZip({ 'some-wrapper/SKILL.md': MINIMAL_SKILL_MD })
      const result = await validateSkillZip(buf)
      expect(result.skillName).toBe('Test Skill')
    })

    it('rejects zip without SKILL.md', async () => {
      const buf = await makeSkillZip({ 'README.md': '# Readme' })
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('SKILL.md not found')
    })

    it('handles macOS wrapper directory prefix', async () => {
      const buf = await makeSkillZip({
        'my-skill/SKILL.md': MINIMAL_SKILL_MD,
        'my-skill/helper.py': 'x = 1',
      })
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(true)
      expect(result.skillName).toBe('Test Skill')
      expect(result.stripPrefix).toBe('my-skill/')
    })

    it('filters __MACOSX entries', async () => {
      const buf = await makeSkillZip({
        'SKILL.md': MINIMAL_SKILL_MD,
        '__MACOSX/._SKILL.md': 'junk',
      })
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('rejects path traversal in entries', async () => {
      // yazl rejects `..` in paths, so we must patch the buffer directly
      const buf = Buffer.from(await makeSkillZip({
        'SKILL.md': MINIMAL_SKILL_MD,
        'safe/evil.txt': 'bad content',
      }))
      const searchStr = Buffer.from('safe/evil.txt')
      const replaceStr = Buffer.from('../evil..txt')
      let idx = buf.indexOf(searchStr)
      while (idx !== -1) {
        replaceStr.copy(buf, idx)
        idx = buf.indexOf(searchStr, idx + 1)
      }
      const result = await validateSkillZip(buf)
      expect(result.valid).toBe(false)
      expect(result.error?.toLowerCase()).toMatch(/invalid.*path/)
    })

    it('handles invalid/corrupt buffer gracefully', async () => {
      const result = await validateSkillZip(Buffer.from('not a zip'))
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.fileCount).toBe(0)
    })
  })

  describe('importSkillFromZip', () => {
    it('imports a valid zip and returns skill info', async () => {
      const agentSlug = 'import-agent'
      // Create the agent workspace dir
      const agentDir = path.join(testDir, 'agents', agentSlug, 'workspace')
      fs.mkdirSync(agentDir, { recursive: true })

      const buf = await makeSkillZip({ 'SKILL.md': MINIMAL_SKILL_MD })
      const result = await importSkillFromZip(agentSlug, buf)

      expect(result.skillDir).toBe('test-skill')
      expect(result.skillName).toBe('Test Skill')

      // Verify file was extracted
      const skillMdPath = path.join(agentDir, '.claude', 'skills', 'test-skill', 'SKILL.md')
      expect(fs.existsSync(skillMdPath)).toBe(true)
      expect(fs.readFileSync(skillMdPath, 'utf-8')).toBe(MINIMAL_SKILL_MD)
    })

    it('derives safe directory name from skill name', async () => {
      const agentSlug = 'safe-name-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const skillMd = `---\nname: My Fancy Skill!\n---\n# Skill\n`
      const buf = await makeSkillZip({ 'SKILL.md': skillMd })
      const result = await importSkillFromZip(agentSlug, buf)

      expect(result.skillDir).toBe('my-fancy-skill')
    })

    it('appends suffix when directory name collides', async () => {
      const agentSlug = 'collision-agent'
      const agentDir = path.join(testDir, 'agents', agentSlug, 'workspace')
      fs.mkdirSync(agentDir, { recursive: true })

      // Pre-create the target directory
      const existingDir = path.join(agentDir, '.claude', 'skills', 'test-skill')
      fs.mkdirSync(existingDir, { recursive: true })

      const buf = await makeSkillZip({ 'SKILL.md': MINIMAL_SKILL_MD })
      const result = await importSkillFromZip(agentSlug, buf)

      expect(result.skillDir).toBe('test-skill-1')
    })

    it('strips wrapper directory prefix', async () => {
      const agentSlug = 'prefix-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const buf = await makeSkillZip({
        'wrapper/SKILL.md': MINIMAL_SKILL_MD,
        'wrapper/helper.py': 'x = 1',
      })
      const result = await importSkillFromZip(agentSlug, buf)

      expect(result.skillDir).toBe('test-skill')
      const skillDir = path.join(testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills', result.skillDir)
      expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(skillDir, 'helper.py'))).toBe(true)
    })

    it('names a frontmatter-less skill after its wrapper directory', async () => {
      const agentSlug = 'wrapper-name-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const buf = await makeSkillZip({
        'reporting-tools/SKILL.md': SKILL_MD_NO_NAME,
        'reporting-tools/helper.py': 'x = 1',
      })
      const result = await importSkillFromZip(agentSlug, buf)

      // skillName is the prettified display form of the wrapper-derived dir.
      expect(result.skillName).toBe('Reporting Tools')
      expect(result.skillDir).toBe('reporting-tools')
    })

    it('falls back to imported-skill only when neither frontmatter name nor wrapper exist', async () => {
      const agentSlug = 'no-name-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const buf = await makeSkillZip({ 'SKILL.md': SKILL_MD_NO_NAME })
      const result = await importSkillFromZip(agentSlug, buf)

      expect(result.skillName).toBe('Imported Skill')
      expect(result.skillDir).toBe('imported-skill')
    })

    it('skips .skillset-metadata.json and .skillset-original.md from source', async () => {
      const agentSlug = 'skip-meta-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const buf = await makeSkillZip({
        'SKILL.md': MINIMAL_SKILL_MD,
        '.skillset-metadata.json': '{"skillsetId": "old"}',
        '.skillset-original.md': '# old',
      })
      const result = await importSkillFromZip(agentSlug, buf)

      const skillDir = path.join(testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills', result.skillDir)
      expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(skillDir, '.skillset-metadata.json'))).toBe(false)
      expect(fs.existsSync(path.join(skillDir, '.skillset-original.md'))).toBe(false)
    })

    it('throws when SKILL.md is missing', async () => {
      const agentSlug = 'no-skill-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const buf = await makeSkillZip({ 'README.md': '# Hi' })
      await expect(importSkillFromZip(agentSlug, buf)).rejects.toThrow('SKILL.md not found')
    })

    it('filters __MACOSX entries during import', async () => {
      const agentSlug = 'macosx-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })

      const buf = await makeSkillZip({
        'SKILL.md': MINIMAL_SKILL_MD,
        '__MACOSX/._SKILL.md': 'resource fork junk',
      })
      const result = await importSkillFromZip(agentSlug, buf)

      const skillDir = path.join(testDir, 'agents', agentSlug, 'workspace', '.claude', 'skills', result.skillDir)
      expect(fs.existsSync(path.join(skillDir, '__MACOSX'))).toBe(false)
    })
  })

  describe('skill zip round-trip', () => {
    it('export then import preserves files', async () => {
      const agentSlug = 'roundtrip-agent'
      const agentDir = path.join(testDir, 'agents', agentSlug, 'workspace')
      fs.mkdirSync(agentDir, { recursive: true })

      // Create a skill to export
      const sourceDir = makeSkillDir(agentSlug, 'source-skill')
      fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), MINIMAL_SKILL_MD)
      fs.writeFileSync(path.join(sourceDir, 'tool.py'), 'def run(): pass')

      // Export it
      const { zipBuffer } = await exportSkill(agentSlug, 'source-skill')

      // Import into a different agent
      const importAgentSlug = 'roundtrip-import'
      fs.mkdirSync(path.join(testDir, 'agents', importAgentSlug, 'workspace'), { recursive: true })
      const result = await importSkillFromZip(importAgentSlug, zipBuffer)

      // Verify files match
      const importedDir = path.join(testDir, 'agents', importAgentSlug, 'workspace', '.claude', 'skills', result.skillDir)
      expect(fs.readFileSync(path.join(importedDir, 'SKILL.md'), 'utf-8')).toBe(MINIMAL_SKILL_MD)
      expect(fs.readFileSync(path.join(importedDir, 'tool.py'), 'utf-8')).toBe('def run(): pass')
    })

    it('export then import preserves the name of a skill with no frontmatter', async () => {
      // Without a frontmatter name, the only carrier of the skill's identity
      // is the wrapper folder the export bakes into the zip — the download
      // filename is deliberately never trusted on import.
      const agentSlug = 'roundtrip-noname-agent'
      fs.mkdirSync(path.join(testDir, 'agents', agentSlug, 'workspace'), { recursive: true })
      const sourceDir = makeSkillDir(agentSlug, 'quarterly-report')
      fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# No frontmatter here\n\nJust instructions.\n')

      const { zipBuffer, skillName } = await exportSkill(agentSlug, 'quarterly-report')
      expect(skillName).toBeNull()

      const importAgentSlug = 'roundtrip-noname-import'
      fs.mkdirSync(path.join(testDir, 'agents', importAgentSlug, 'workspace'), { recursive: true })
      const result = await importSkillFromZip(importAgentSlug, zipBuffer)

      // Display name derives from the wrapper folder, not 'Imported Skill'.
      expect(result.skillName).toBe('Quarterly Report')
      expect(result.skillDir).toBe('quarterly-report')
    })
  })
})
