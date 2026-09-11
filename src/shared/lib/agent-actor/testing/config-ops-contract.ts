/**
 * The `ConfigOps` contract as a test suite, run against every implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigDocError } from '../config-schema'
import type { ConfigOps, FileOps } from '../types'

export interface ConfigOpsHarness {
  config: ConfigOps
  /** The same workspace, to inspect what was stored. */
  files: FileOps
  dispose?: () => Promise<void> | void
}

const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)

export function describeConfigOpsContract(name: string, make: () => Promise<ConfigOpsHarness> | ConfigOpsHarness): void {
  describe(`${name} — ConfigOps contract`, () => {
    let harness: ConfigOpsHarness
    let config: ConfigOps
    let files: FileOps

    beforeEach(async () => {
      harness = await make()
      config = harness.config
      files = harness.files
    })

    afterEach(async () => {
      await harness.dispose?.()
    })

    it('an absent document is null', async () => {
      expect(await config.get('instructions')).toBeNull()
      expect(await config.get('preferences')).toBeNull()
    })

    it('text documents round-trip verbatim at their workspace path', async () => {
      await config.put('instructions', '---\nname: A\n---\nBe kind.\n')
      expect(await config.get('instructions')).toBe('---\nname: A\n---\nBe kind.\n')
      expect(decode(await files.getDoc('CLAUDE.md'))).toBe('---\nname: A\n---\nBe kind.\n')

      await config.put('secrets', 'API_KEY=x\n')
      expect(decode(await files.getDoc('.env'))).toBe('API_KEY=x\n')
    })

    it('JSON documents are validated on write, stored pretty-printed, and validated on read', async () => {
      await config.put('preferences', { defaultModel: 'claude-x' })
      expect(await config.get('preferences')).toEqual({ defaultModel: 'claude-x' })
      expect(decode(await files.getDoc('agent-preferences.json'))).toBe(
        JSON.stringify({ defaultModel: 'claude-x' }, null, 2),
      )

      await expect(config.put('preferences', 'not an object' as never)).rejects.toBeInstanceOf(ConfigDocError)
      await expect(config.put('preferences', { defaultModel: 42 } as never)).rejects.toMatchObject({ code: 'invalid' })
      // The bad writes left the stored document alone.
      expect(await config.get('preferences')).toEqual({ defaultModel: 'claude-x' })
    })

    it('a stored document that is not valid JSON, or does not fit its schema, is corrupt — never silently replaced', async () => {
      await files.putDoc('agent-preferences.json', '{ not json')
      await expect(config.get('preferences')).rejects.toMatchObject({ code: 'corrupt', docId: 'preferences' })

      await files.putDoc('agent-preferences.json', JSON.stringify({ defaultModel: 42 }))
      await expect(config.get('preferences')).rejects.toMatchObject({ code: 'corrupt' })

      // update reads strictly first, so a corrupt document aborts the write.
      await expect(config.update('preferences', () => ({}))).rejects.toMatchObject({ code: 'corrupt' })
      expect(decode(await files.getDoc('agent-preferences.json'))).toBe(JSON.stringify({ defaultModel: 42 }))
    })

    it('update hands the current document to the mutator and stores what it returns', async () => {
      const first = await config.update('secrets', (current) => `${current ?? ''}A=1\n`)
      expect(first).toBe('A=1\n')
      const second = await config.update('secrets', (current) => `${current ?? ''}B=2\n`)
      expect(second).toBe('A=1\nB=2\n')
      expect(await config.get('secrets')).toBe('A=1\nB=2\n')
    })

    it('an update whose mutator returns the current document unchanged writes nothing', async () => {
      await config.put('secrets', 'A=1\n')
      const writes = vi.spyOn(files, 'putDoc')
      expect(await config.update('secrets', (current) => current ?? '')).toBe('A=1\n')
      expect(writes).not.toHaveBeenCalled()
      // …but an absent document is still created, even as empty.
      expect(await config.update('instructions', (current) => current ?? '')).toBe('')
      expect(writes).toHaveBeenCalledTimes(1)
      writes.mockRestore()
    })

    it('concurrent updates of one document are serialized, so no write is lost', async () => {
      await config.put('secrets', '')
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => config.update('secrets', (current) => `${current ?? ''}K${i}=v\n`)),
      )
      const lines = ((await config.get('secrets')) ?? '').trim().split('\n').sort()
      expect(lines).toEqual(Array.from({ length: 8 }, (_, i) => `K${i}=v`).sort())
    })

    it('settings pass unknown keys through and hooks fit their schema', async () => {
      await config.put('claudeSettings', { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] } } as never)
      const stored = (await config.get('claudeSettings')) as Record<string, unknown>
      expect(stored.theme).toBe('dark')
      expect(stored.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] })
    })
  })
}
