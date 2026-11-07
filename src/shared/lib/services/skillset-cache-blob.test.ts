import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSystemBlobStore, setBlobStore, type BlobStore } from '@shared/lib/blob-store/blob-store'
import { memoryBlobStore as memoryStore } from '@shared/lib/blob-store/testing/memory-blob-store'
import { deleteSkillsetCache, restoreSkillsetCache, saveSkillsetCache } from './skillset-cache-blob'

const KEY = 'skillset-cache-packs/platform--sales-playbooks'
const tempDirs: string[] = []

function skillsetDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillset-cache-'))
  tempDirs.push(root)
  const dir = path.join(root, 'platform--sales-playbooks')
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

afterEach(() => {
  setBlobStore(null)
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

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

  it('does not overlay an existing folder whose index is missing', async () => {
    setBlobStore(memoryStore())
    const dir = skillsetDir()
    await saveSkillsetCache(dir)
    fs.unlinkSync(path.join(dir, 'index.json'))
    fs.writeFileSync(path.join(dir, 'skills', 'lead-research', 'SKILL.md'), '# Fresh download\n')

    expect(await restoreSkillsetCache(dir)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(false)
    expect(skillText(dir)).toBe('# Fresh download\n')
  })

  it.each([
    ['truncated JSON', '{'],
    ['missing files', JSON.stringify({ v: 1, version: '00000000-0000-4000-8000-000000000001' })],
    ['unsupported format', JSON.stringify({ v: 2, version: '00000000-0000-4000-8000-000000000001', files: [] })],
    ['invalid file bytes', JSON.stringify({ v: 1, version: '00000000-0000-4000-8000-000000000001', files: [{ path: 'index.json', data: 'not base64!', mode: 0o600 }] })],
  ])('treats %s as a cache miss without creating a partial folder', async (_name, contents) => {
    const store = memoryStore()
    setBlobStore(store)
    const dir = skillsetDir()
    await saveSkillsetCache(dir)
    await store.put(KEY, Buffer.from(contents))
    fs.rmSync(dir, { recursive: true, force: true })

    await expect(restoreSkillsetCache(dir)).resolves.toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('reads the folder once after a save in the same process, then only the version marker', async () => {
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
    expect(reads).toEqual([`${KEY}.version`, KEY, `${KEY}.version`, `${KEY}.version`])
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

  it('reads the folder once when two saves raced and the marker names the other save', async () => {
    const store = memoryStore()
    const reads: string[] = []
    setBlobStore({ ...store, get: async (key) => {
      reads.push(key)
      return store.get(key)
    } })
    const dir = skillsetDir()
    const other = await otherProcess(store)
    await other.saveSkillsetCache(dir)
    const otherMarker = await store.get(`${KEY}.version`)
    // This process's folder lands last, but the other process's marker does.
    await saveSkillsetCache(dir)
    await store.put(`${KEY}.version`, otherMarker!)
    reads.length = 0

    for (let request = 0; request < 3; request++) {
      fs.rmSync(dir, { recursive: true, force: true })
      expect(await restoreSkillsetCache(dir)).toBe(true)
    }
    expect(reads).toEqual([`${KEY}.version`, KEY, `${KEY}.version`, `${KEY}.version`])
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

  it('keeps the packed copy next to the cache folder, not inside it, in a file system store', async () => {
    const dir = skillsetDir()
    const dataDir = path.dirname(dir)
    const cacheDir = path.join(dataDir, 'skillset-cache')
    fs.mkdirSync(cacheDir)
    const cached = path.join(cacheDir, path.basename(dir))
    fs.renameSync(dir, cached)
    setBlobStore(new FileSystemBlobStore(() => dataDir))

    await saveSkillsetCache(cached)
    fs.rmSync(cached, { recursive: true, force: true })

    expect(fs.existsSync(path.join(dataDir, KEY))).toBe(true)
    expect(await restoreSkillsetCache(cached)).toBe(true)
    expect(skillText(cached)).toBe('# Lead research\nFind the decision maker.\n')
  })
})
