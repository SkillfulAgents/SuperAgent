import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { setBlobStore, type BlobStore } from '@shared/lib/blob-store/blob-store'
import { deleteSkillsetCache, restoreSkillsetCache, saveSkillsetCache } from './skillset-cache-blob'

function memoryStore(): BlobStore & { keys(): string[] } {
  const blobs = new Map<string, Uint8Array>()
  return {
    get: async (key) => blobs.get(key) ?? null,
    put: async (key, bytes) => {
      blobs.set(key, bytes)
    },
    delete: async (key) => {
      blobs.delete(key)
    },
    keys: () => [...blobs.keys()],
  }
}

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

afterEach(() => setBlobStore(null))

describe('skillset cache in the blob store', () => {
  it('restores a saved folder into an empty data dir', async () => {
    const store = memoryStore()
    setBlobStore(store)
    const dir = skillsetDir()

    await saveSkillsetCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })

    expect(await restoreSkillsetCache(dir)).toBe(true)
    expect(store.keys()).toEqual(['skillset-cache/platform--sales-playbooks'])
    expect(fs.readFileSync(path.join(dir, 'skills', 'lead-research', 'SKILL.md'), 'utf-8')).toBe('# Lead research\nFind the decision maker.\n')
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

  it('restores from memory, without reading the store, after a save in the same process', async () => {
    const store = memoryStore()
    const reads = { count: 0 }
    setBlobStore({ ...store, get: async (key) => {
      reads.count++
      return store.get(key)
    } })
    const dir = skillsetDir()
    await saveSkillsetCache(dir)

    for (let request = 0; request < 3; request++) {
      fs.rmSync(dir, { recursive: true, force: true })
      expect(await restoreSkillsetCache(dir)).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8')).toContain('lead-research')
    }
    expect(reads.count).toBe(0)
  })

  it('does nothing without a store', async () => {
    const dir = skillsetDir()
    await saveSkillsetCache(dir)
    fs.rmSync(dir, { recursive: true, force: true })

    expect(await restoreSkillsetCache(dir)).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
