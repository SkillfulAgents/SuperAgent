import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBlobStore, type BlobStore } from '@shared/lib/blob-store/blob-store'
import { memoryBlobStore as memoryStore } from '@shared/lib/blob-store/testing/memory-blob-store'
import { deleteSkillsetCache, restoreSkillsetCache, saveSkillsetCache } from './skillset-cache-blob'

const KEY = 'skillset-cache/platform--sales-playbooks'

function skillsetDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skillset-cache-')), 'platform--sales-playbooks')
  fs.mkdirSync(path.join(dir, 'skills', 'lead-research'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, 'index.json'), '{"skills":[{"name":"lead-research","path":"skills/lead-research"}]}')
  fs.writeFileSync(path.join(dir, 'skills', 'lead-research', 'SKILL.md'), '# Lead research\nFind the decision maker.\n')
  fs.writeFileSync(path.join(dir, 'skills', 'lead-research', 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
}

/** The same module in a second process that shares the store: its own memory, the same blobs. */
async function otherProcess(store: BlobStore) {
  vi.resetModules()
  ;(await import('@shared/lib/blob-store/blob-store')).setBlobStore(store)
  return import('./skillset-cache-blob')
}

const skillText = (dir: string) => fs.readFileSync(path.join(dir, 'skills', 'lead-research', 'SKILL.md'), 'utf-8')

afterEach(() => setBlobStore(null))

describe('skillset cache in the blob store', () => {
  it('restores a saved folder into an empty data dir', async () => {
    const store = memoryStore()
    setBlobStore(store)
    const dir = skillsetDir()

    await saveSkillsetCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })

    expect(await restoreSkillsetCache(dir)).toBe(true)
    expect(store.keys()).toEqual([KEY, `${KEY}.version`])
    expect(skillText(dir)).toBe('# Lead research\nFind the decision maker.\n')
    expect(fs.statSync(path.join(dir, 'skills', 'lead-research', 'run.sh')).mode & 0o777).toBe(0o755)
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
  })

  it('finds nothing to restore once the stored copy is deleted', async () => {
    setBlobStore(memoryStore())
    const dir = skillsetDir()
    await saveSkillsetCache(dir)

    await deleteSkillsetCache(dir)

    expect(await restoreSkillsetCache(dir)).toBe(false)
  })

  it('reads only the version marker, not the folder, after a save in the same process', async () => {
    const store = memoryStore()
    const reads: string[] = []
    setBlobStore({ ...store, get: async (key) => {
      reads.push(key)
      return store.get(key)
    } })
    const dir = skillsetDir()
    await saveSkillsetCache(dir)

    for (let request = 0; request < 3; request++) {
      fs.rmSync(dir, { recursive: true, force: true })
      expect(await restoreSkillsetCache(dir)).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8')).toContain('lead-research')
    }
    expect(reads).toEqual([`${KEY}.version`, `${KEY}.version`, `${KEY}.version`])
  })

  it('restores the folder another process saved after this one read it', async () => {
    const store = memoryStore()
    setBlobStore(store)
    const dir = skillsetDir()
    await saveSkillsetCache(dir)
    const other = await otherProcess(store)

    fs.writeFileSync(path.join(dir, 'skills', 'lead-research', 'SKILL.md'), '# Lead research\nFind the budget owner.\n')
    await other.saveSkillsetCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })

    expect(await restoreSkillsetCache(dir)).toBe(true)
    expect(skillText(dir)).toBe('# Lead research\nFind the budget owner.\n')
  })

  it('finds nothing to restore once another process deleted the stored copy', async () => {
    const store = memoryStore()
    setBlobStore(store)
    const dir = skillsetDir()
    await saveSkillsetCache(dir)
    const other = await otherProcess(store)

    await other.deleteSkillsetCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })

    expect(await restoreSkillsetCache(dir)).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('does nothing without a store', async () => {
    const dir = skillsetDir()
    await saveSkillsetCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })

    expect(await restoreSkillsetCache(dir)).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
