import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { agentPreferencesSchema } from '@shared/lib/types/agent-preferences'
import {
  readAgentPreferences,
  writeAgentPreferences,
  updateAgentPreferences,
} from './agent-preferences-service'

describe('agent-preferences-service', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-prefs-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
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

  async function createWorkspaceDir(agentSlug: string): Promise<string> {
    const workspaceDir = path.join(testDir, 'agents', agentSlug, 'workspace')
    await fs.promises.mkdir(workspaceDir, { recursive: true })
    return workspaceDir
  }

  async function writePrefsFile(
    agentSlug: string,
    content: string
  ): Promise<void> {
    const workspaceDir = await createWorkspaceDir(agentSlug)
    await fs.promises.writeFile(
      path.join(workspaceDir, 'agent-preferences.json'),
      content
    )
  }

  async function readPrefsFile(agentSlug: string): Promise<string> {
    const filePath = path.join(
      testDir,
      'agents',
      agentSlug,
      'workspace',
      'agent-preferences.json'
    )
    return fs.promises.readFile(filePath, 'utf-8')
  }

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('agentPreferencesSchema', () => {
    it('accepts empty object', () => {
      expect(agentPreferencesSchema.parse({})).toEqual({})
    })

    it('accepts valid autoDeleteInactiveDays', () => {
      expect(agentPreferencesSchema.parse({ autoDeleteInactiveDays: 30 })).toEqual({
        autoDeleteInactiveDays: 30,
      })
    })

    it('accepts undefined autoDeleteInactiveDays', () => {
      expect(agentPreferencesSchema.parse({})).toEqual({})
    })

    it('rejects zero', () => {
      expect(() =>
        agentPreferencesSchema.parse({ autoDeleteInactiveDays: 0 })
      ).toThrow()
    })

    it('rejects negative numbers', () => {
      expect(() =>
        agentPreferencesSchema.parse({ autoDeleteInactiveDays: -5 })
      ).toThrow()
    })

    it('rejects non-integer numbers', () => {
      expect(() =>
        agentPreferencesSchema.parse({ autoDeleteInactiveDays: 30.5 })
      ).toThrow()
    })

    it('rejects string values', () => {
      expect(() =>
        agentPreferencesSchema.parse({ autoDeleteInactiveDays: '30' })
      ).toThrow()
    })

    it('strips unknown keys', () => {
      const result = agentPreferencesSchema.parse({
        autoDeleteInactiveDays: 30,
        unknownKey: 'should be removed',
      })
      expect(result).toEqual({ autoDeleteInactiveDays: 30 })
      expect('unknownKey' in result).toBe(false)
    })

    it('accepts valid defaultModel and defaultEffort', () => {
      expect(
        agentPreferencesSchema.parse({ defaultModel: 'opus', defaultEffort: 'high' })
      ).toEqual({ defaultModel: 'opus', defaultEffort: 'high' })
    })

    it('rejects an empty defaultModel', () => {
      expect(() => agentPreferencesSchema.parse({ defaultModel: '' })).toThrow()
    })

    // The container file hook shares this schema shape; a whitespace-only model
    // that passed validation would ride the ?? chains onto the wire and break
    // every spawn for the agent.
    it('rejects a whitespace-only defaultModel and trims a padded one', () => {
      expect(() => agentPreferencesSchema.parse({ defaultModel: '   ' })).toThrow()
      expect(agentPreferencesSchema.parse({ defaultModel: ' opus ' })).toEqual({
        defaultModel: 'opus',
      })
    })

    it('rejects a non-string defaultModel', () => {
      expect(() => agentPreferencesSchema.parse({ defaultModel: 42 })).toThrow()
    })

    it('rejects an unknown defaultEffort level', () => {
      expect(() => agentPreferencesSchema.parse({ defaultEffort: 'turbo' })).toThrow()
    })
  })

  // ==========================================================================
  // readAgentPreferences
  // ==========================================================================

  describe('readAgentPreferences', () => {
    it('returns empty object when file does not exist', async () => {
      await createWorkspaceDir('test-agent')
      const result = await readAgentPreferences('test-agent')
      expect(result).toEqual({})
    })

    it('reads valid preferences', async () => {
      await writePrefsFile(
        'test-agent',
        JSON.stringify({ autoDeleteInactiveDays: 90 })
      )
      const result = await readAgentPreferences('test-agent')
      expect(result).toEqual({ autoDeleteInactiveDays: 90 })
    })

    it('returns empty object for corrupted JSON', async () => {
      await writePrefsFile('test-agent', 'not valid json{{{')
      const result = await readAgentPreferences('test-agent')
      expect(result).toEqual({})
    })

    it('strips unknown keys on read', async () => {
      await writePrefsFile(
        'test-agent',
        JSON.stringify({
          autoDeleteInactiveDays: 30,
          injectedKey: 'malicious',
        })
      )
      const result = await readAgentPreferences('test-agent')
      expect(result).toEqual({ autoDeleteInactiveDays: 30 })
      expect('injectedKey' in result).toBe(false)
    })

    it('returns empty object when preferences have invalid values', async () => {
      await writePrefsFile(
        'test-agent',
        JSON.stringify({ autoDeleteInactiveDays: -1 })
      )
      const result = await readAgentPreferences('test-agent')
      expect(result).toEqual({})
    })

    // Fail-open: preferences only supply defaults, and every session-spawn
    // site reads them — a non-corrupt read failure (EACCES, EISDIR, transient
    // FS errors) must degrade to {} rather than take down session creation.
    it('returns empty object when the file is unreadable (not just corrupt)', async () => {
      const workspaceDir = await createWorkspaceDir('test-agent')
      // A directory at the prefs path makes reads fail with EISDIR — a
      // non-corrupt I/O error, unlike the garbled-JSON cases above.
      await fs.promises.mkdir(path.join(workspaceDir, 'agent-preferences.json'))
      const result = await readAgentPreferences('test-agent')
      expect(result).toEqual({})
    })

    it('an unreadable file still aborts the read-modify-write update path', async () => {
      const workspaceDir = await createWorkspaceDir('test-agent')
      await fs.promises.mkdir(path.join(workspaceDir, 'agent-preferences.json'))
      await expect(
        updateAgentPreferences('test-agent', { autoDeleteInactiveDays: 30 })
      ).rejects.toThrow()
    })
  })

  // ==========================================================================
  // writeAgentPreferences
  // ==========================================================================

  describe('writeAgentPreferences', () => {
    it('writes preferences to file', async () => {
      await createWorkspaceDir('test-agent')
      await writeAgentPreferences('test-agent', { autoDeleteInactiveDays: 365 })

      const content = JSON.parse(await readPrefsFile('test-agent'))
      expect(content).toEqual({ autoDeleteInactiveDays: 365 })
    })

    it('validates before writing', async () => {
      await createWorkspaceDir('test-agent')
      await expect(
        writeAgentPreferences('test-agent', {
          autoDeleteInactiveDays: -1,
        } as never)
      ).rejects.toThrow()
    })
  })

  // ==========================================================================
  // updateAgentPreferences
  // ==========================================================================

  describe('updateAgentPreferences', () => {
    it('creates file if it does not exist', async () => {
      await createWorkspaceDir('test-agent')
      const result = await updateAgentPreferences('test-agent', {
        autoDeleteInactiveDays: 30,
      })
      expect(result).toEqual({ autoDeleteInactiveDays: 30 })

      const content = JSON.parse(await readPrefsFile('test-agent'))
      expect(content).toEqual({ autoDeleteInactiveDays: 30 })
    })

    it('merges with existing preferences', async () => {
      await writePrefsFile(
        'test-agent',
        JSON.stringify({ autoDeleteInactiveDays: 30 })
      )
      const result = await updateAgentPreferences('test-agent', {
        autoDeleteInactiveDays: 90,
      })
      expect(result).toEqual({ autoDeleteInactiveDays: 90 })
    })

    it('removes field when set to null', async () => {
      await writePrefsFile(
        'test-agent',
        JSON.stringify({ autoDeleteInactiveDays: 30 })
      )
      const result = await updateAgentPreferences('test-agent', {
        autoDeleteInactiveDays: null,
      })
      expect(result).toEqual({})
      expect('autoDeleteInactiveDays' in result).toBe(false)
    })

    it('removes field when set to undefined', async () => {
      await writePrefsFile(
        'test-agent',
        JSON.stringify({ autoDeleteInactiveDays: 30 })
      )
      const result = await updateAgentPreferences('test-agent', {
        autoDeleteInactiveDays: undefined,
      })
      expect(result).toEqual({})
    })

    it('strips unknown keys from updates', async () => {
      await createWorkspaceDir('test-agent')
      const result = await updateAgentPreferences('test-agent', {
        autoDeleteInactiveDays: 30,
        evilKey: 'should be stripped',
      } as Record<string, unknown>)
      expect(result).toEqual({ autoDeleteInactiveDays: 30 })
      expect('evilKey' in result).toBe(false)
    })
  })
})
