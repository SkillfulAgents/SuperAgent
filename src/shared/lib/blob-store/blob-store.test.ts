import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileSystemBlobStore, hostFiles, setBlobStore } from './blob-store'
import { memoryBlobStore as memoryStore } from './testing/memory-blob-store'

describe('FileSystemBlobStore', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-store-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps each key as a file below its root, readable only by the owner', async () => {
    const store = new FileSystemBlobStore(() => dir)

    await store.put('profile-photos/photo-1.png', Buffer.from('png bytes'))
    await store.put('profile-photos/photo-1.png', Buffer.from('new png bytes'))

    const onDisk = path.join(dir, 'profile-photos', 'photo-1.png')
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('new png bytes')
    expect(fs.statSync(onDisk).mode & 0o777).toBe(0o600)
    expect(Buffer.from((await store.get('profile-photos/photo-1.png'))!).toString()).toBe('new png bytes')
    await store.delete('profile-photos/photo-1.png')
    expect(await store.get('profile-photos/photo-1.png')).toBeNull()
    await expect(store.delete('profile-photos/photo-1.png')).resolves.toBeUndefined()
  })

  it('refuses a key that would leave its root', async () => {
    const store = new FileSystemBlobStore(() => dir)

    await expect(store.put('../settings.json', Buffer.from('{}'))).rejects.toThrow('Invalid blob key')
    await expect(store.get('model-icons/./icon.svg')).rejects.toThrow('Invalid blob key')
    await expect(store.get('/etc/passwd')).rejects.toThrow('Invalid blob key')
  })
})

describe('hostFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-files-'))
    vi.stubEnv('SUPERAGENT_DATA_DIR', dir)
  })
  afterEach(() => {
    setBlobStore(null)
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps files in the data dir by default, where they lived before', async () => {
    const files = hostFiles('profile-photos')

    await files.write('photo-1.png', Buffer.from('png bytes'))

    expect(fs.readFileSync(path.join(dir, 'profile-photos', 'photo-1.png'), 'utf8')).toBe('png bytes')
    await files.remove('photo-1.png')
    expect(await files.read('photo-1.png')).toBeNull()
  })

  it('keeps files under its prefix in the store a deployment set, and nothing on disk', async () => {
    const store = memoryStore()
    setBlobStore(store)
    const files = hostFiles('model-icons')

    await files.write('icon-1.svg', Buffer.from('<svg />'))

    expect(store.keys()).toEqual(['model-icons/icon-1.svg'])
    expect(fs.existsSync(path.join(dir, 'model-icons'))).toBe(false)
    expect(Buffer.from((await files.read('icon-1.svg'))!).toString()).toBe('<svg />')
    await files.remove('icon-1.svg')
    expect(store.keys()).toEqual([])
  })

  it('refuses a name that would leave its folder', async () => {
    const files = hostFiles('model-icons')

    await expect(files.write('../settings.json', Buffer.from('{}'))).rejects.toThrow('Invalid file name')
    await expect(files.read('nested/icon.svg')).rejects.toThrow('Invalid file name')
    await expect(files.read('.')).rejects.toThrow('Invalid file name')
  })
})
