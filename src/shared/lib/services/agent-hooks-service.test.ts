import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readAgentHooks, removeAgentHook } from './agent-hooks-service'

const AGENT = 'test-agent'

describe('agent-hooks-service', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-hooks-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function settingsPath(): string {
    return path.join(testDir, 'agents', AGENT, 'workspace', '.claude', 'settings.json')
  }

  function writeSettings(settings: unknown): void {
    const p = settingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, typeof settings === 'string' ? settings : JSON.stringify(settings))
  }

  // The incident shape: a self-installed UserPromptSubmit gate plus an
  // unrelated setting the CLI owns.
  const INCIDENT_SETTINGS = {
    cleanupPeriodDays: 9999,
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: 'python3 /workspace/.claude/hooks/deadping_gate.py', timeout: 10 },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo pre-bash' }],
        },
      ],
    },
  }

  describe('readAgentHooks', () => {
    it('returns [] when the settings file does not exist', async () => {
      expect(await readAgentHooks(AGENT)).toEqual([])
    })

    it('returns [] when the settings file is not valid JSON', async () => {
      writeSettings('{ not json')
      expect(await readAgentHooks(AGENT)).toEqual([])
    })

    it('returns [] when there is no hooks key', async () => {
      writeSettings({ cleanupPeriodDays: 9999 })
      expect(await readAgentHooks(AGENT)).toEqual([])
    })

    it('flattens hooks to one row per command, carrying event/matcher/timeout', async () => {
      writeSettings(INCIDENT_SETTINGS)
      const hooks = await readAgentHooks(AGENT)
      expect(hooks).toEqual([
        {
          event: 'UserPromptSubmit',
          type: 'command',
          command: 'python3 /workspace/.claude/hooks/deadping_gate.py',
          timeout: 10,
        },
        { event: 'PreToolUse', matcher: 'Bash', type: 'command', command: 'echo pre-bash' },
      ])
    })

    it('flattens prompt-type hooks (no command field)', async () => {
      writeSettings({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'prompt', prompt: 'Reject messages starting with hey' }] },
          ],
        },
      })
      const hooks = await readAgentHooks(AGENT)
      expect(hooks).toEqual([
        { event: 'UserPromptSubmit', matcher: '', type: 'prompt', prompt: 'Reject messages starting with hey' },
      ])
    })

    it('tolerates unknown hook fields (loose parse)', async () => {
      writeSettings({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo done', unknownField: true }] }],
        },
      })
      const hooks = await readAgentHooks(AGENT)
      expect(hooks).toHaveLength(1)
      expect(hooks[0].command).toBe('echo done')
    })
  })

  describe('removeAgentHook', () => {
    it('removes the target hook and preserves every other settings key', async () => {
      writeSettings(INCIDENT_SETTINGS)
      const remaining = await removeAgentHook(AGENT, {
        event: 'UserPromptSubmit',
        command: 'python3 /workspace/.claude/hooks/deadping_gate.py',
      })
      expect(remaining).toEqual([
        { event: 'PreToolUse', matcher: 'Bash', type: 'command', command: 'echo pre-bash' },
      ])

      const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      expect(onDisk.cleanupPeriodDays).toBe(9999)
      expect(onDisk.hooks.UserPromptSubmit).toBeUndefined()
      expect(onDisk.hooks.PreToolUse).toHaveLength(1)
    })

    it('drops the hooks key entirely when the last hook is removed', async () => {
      writeSettings({
        cleanupPeriodDays: 9999,
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo x' }] }] },
      })
      const remaining = await removeAgentHook(AGENT, { event: 'UserPromptSubmit', command: 'echo x' })
      expect(remaining).toEqual([])

      const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      expect(onDisk.hooks).toBeUndefined()
      expect(onDisk.cleanupPeriodDays).toBe(9999)
    })

    it('only removes from the matching matcher group', async () => {
      writeSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo x' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: 'echo x' }] },
          ],
        },
      })
      const remaining = await removeAgentHook(AGENT, {
        event: 'PreToolUse',
        command: 'echo x',
        matcher: 'Bash',
      })
      expect(remaining).toEqual([
        { event: 'PreToolUse', matcher: 'Write', type: 'command', command: 'echo x' },
      ])
    })

    it('leaves other hooks in the same group intact', async () => {
      writeSettings({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo a' }, { type: 'command', command: 'echo b' }] },
          ],
        },
      })
      const remaining = await removeAgentHook(AGENT, { event: 'UserPromptSubmit', command: 'echo a' })
      expect(remaining).toEqual([
        { event: 'UserPromptSubmit', type: 'command', command: 'echo b' },
      ])
    })

    it('removes a prompt-type hook by prompt', async () => {
      writeSettings({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'prompt', prompt: 'Reject hey' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'echo gate' }] },
          ],
        },
      })
      const remaining = await removeAgentHook(AGENT, {
        event: 'UserPromptSubmit',
        matcher: '',
        prompt: 'Reject hey',
      })
      expect(remaining).toEqual([
        { event: 'UserPromptSubmit', matcher: '', type: 'command', command: 'echo gate' },
      ])
    })

    it('throws (and does not rewrite) when the settings file is not valid JSON', async () => {
      writeSettings('{ definitely not json')
      await expect(
        removeAgentHook(AGENT, { event: 'UserPromptSubmit', command: 'echo x' })
      ).rejects.toThrow('not valid JSON')
      expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe('{ definitely not json')
    })

    it('throws when the settings file does not exist', async () => {
      await expect(
        removeAgentHook(AGENT, { event: 'UserPromptSubmit', command: 'echo x' })
      ).rejects.toThrow()
    })
  })
})
