import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostFiles, setBlobStore } from './blob-store'
import { memoryBlobStore as memoryStore } from './testing/memory-blob-store'

describe('hostFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-files-'))
  })
  afterEach(() => {
    setBlobStore(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps files on disk, readable only by the owner, when no blob store is set', async () => {
    const files = hostFiles('profile-photos', () => path.join(dir, 'profile-photos'))

    await files.write('photo-1.png', Buffer.from('png bytes'))

    const onDisk = path.join(dir, 'profile-photos', 'photo-1.png')
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('png bytes')
    expect(fs.statSync(onDisk).mode & 0o777).toBe(0o600)
    expect(Buffer.from((await files.read('photo-1.png'))!).toString()).toBe('png bytes')
    await files.remove('photo-1.png')
    expect(await files.read('photo-1.png')).toBeNull()
    await expect(files.remove('photo-1.png')).resolves.toBeUndefined()
  })

  it('keeps files in the blob store under its folder, and nothing on disk, when one is set', async () => {
    const store = memoryStore()
    setBlobStore(store)
    const files = hostFiles('model-icons', () => path.join(dir, 'model-icons'))

    await files.write('icon-1.svg', Buffer.from('<svg />'))

    expect(store.keys()).toEqual(['model-icons/icon-1.svg'])
    expect(fs.existsSync(path.join(dir, 'model-icons'))).toBe(false)
    expect(Buffer.from((await files.read('icon-1.svg'))!).toString()).toBe('<svg />')
    await files.remove('icon-1.svg')
    expect(store.keys()).toEqual([])
    expect(await files.read('icon-1.svg')).toBeNull()
  })

  it('refuses a name that would leave its folder', async () => {
    const files = hostFiles('model-icons', () => path.join(dir, 'model-icons'))

    await expect(files.write('../settings.json', Buffer.from('{}'))).rejects.toThrow('Invalid file name')
    await expect(files.read('nested/icon.svg')).rejects.toThrow('Invalid file name')
  })
})
