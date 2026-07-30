import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import os from 'os'
import path from 'path'
import {
  MAX_UPLOAD_TOTAL_SIZE,
  UploadTooLargeError,
  cleanupStaleTempUploads,
  moveUploadedFile,
  storeUploadChunk,
} from './chunked-upload'

const tmpRoot = path.join(os.tmpdir(), `chunked-upload-${process.pid}-${Date.now()}`)
const tempUploadsDir = path.join(tmpRoot, 'tmp', 'uploads')

vi.mock('./file-storage', async () => {
  const actual = await vi.importActual<typeof import('./file-storage')>('./file-storage')
  return {
    ...actual,
    getTempUploadsDir: () => tempUploadsDir,
  }
})

describe('storeUploadChunk', () => {
  beforeEach(async () => {
    await fs.promises.mkdir(tempUploadsDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns received until all chunks arrive', async () => {
    const uploadId = '11111111-1111-1111-1111-111111111111'
    const r0 = await storeUploadChunk(uploadId, 0, 2, Buffer.from('aa'))
    expect(r0).toEqual({ status: 'received' })
    expect(fs.existsSync(path.join(tempUploadsDir, uploadId, 'chunk-0'))).toBe(true)
  })

  it('streams chunks to an assembled temp file without reading chunk files whole', async () => {
    const uploadId = '22222222-2222-2222-2222-222222222222'
    const readFileSpy = vi.spyOn(fs.promises, 'readFile')

    await storeUploadChunk(uploadId, 0, 2, Buffer.from('hello '))
    const result = await storeUploadChunk(uploadId, 1, 2, Buffer.from('world'))

    expect(result.status).toBe('assembled')
    if (result.status !== 'assembled') return

    expect(readFileSpy).not.toHaveBeenCalled()
    readFileSpy.mockRestore()

    const assembled = await fs.promises.readFile(result.filePath)
    expect(assembled.toString()).toBe('hello world')
    expect(fs.existsSync(path.join(tempUploadsDir, uploadId))).toBe(false)

    await fs.promises.unlink(result.filePath)
  })

  it('rejects when projected size exceeds maxTotalBytes and cleans the upload dir', async () => {
    const uploadId = '33333333-3333-3333-3333-333333333333'
    await storeUploadChunk(uploadId, 0, 2, Buffer.from('0123456789'), 15)

    await expect(storeUploadChunk(uploadId, 1, 2, Buffer.from('0123456789'), 15)).rejects.toBeInstanceOf(
      UploadTooLargeError,
    )
    expect(fs.existsSync(path.join(tempUploadsDir, uploadId))).toBe(false)
  })

  it('accounts for overwriting an existing chunk index when capping', async () => {
    const uploadId = '44444444-4444-4444-4444-444444444444'
    await storeUploadChunk(uploadId, 0, 2, Buffer.from('aaaa'), 10)
    // Overwrite chunk-0 with same size — still under cap
    const r = await storeUploadChunk(uploadId, 0, 2, Buffer.from('bbbb'), 10)
    expect(r.status).toBe('received')

    const assembled = await storeUploadChunk(uploadId, 1, 2, Buffer.from('cc'), 10)
    expect(assembled.status).toBe('assembled')
    if (assembled.status === 'assembled') {
      expect(await fs.promises.readFile(assembled.filePath, 'utf8')).toBe('bbbbcc')
      await fs.promises.unlink(assembled.filePath)
    }
  })
})

describe('moveUploadedFile', () => {
  beforeEach(async () => {
    await fs.promises.mkdir(tmpRoot, { recursive: true })
  })

  afterEach(async () => {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true })
  })

  it('renames when source and dest share a filesystem', async () => {
    const src = path.join(tmpRoot, 'src.bin')
    const dest = path.join(tmpRoot, 'dest', 'out.bin')
    await fs.promises.writeFile(src, 'payload')

    const size = await moveUploadedFile(src, dest)
    expect(size).toBe(7)
    expect(await fs.promises.readFile(dest, 'utf8')).toBe('payload')
    expect(fs.existsSync(src)).toBe(false)
  })

  it('falls back to stream copy on EXDEV', async () => {
    const src = path.join(tmpRoot, 'exdev-src.bin')
    const dest = path.join(tmpRoot, 'exdev-dest', 'out.bin')
    await fs.promises.writeFile(src, 'cross-device')

    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
    )

    const size = await moveUploadedFile(src, dest)
    expect(size).toBe(Buffer.byteLength('cross-device'))
    expect(await fs.promises.readFile(dest, 'utf8')).toBe('cross-device')
    expect(fs.existsSync(src)).toBe(false)
    renameSpy.mockRestore()
  })
})

describe('cleanupStaleTempUploads', () => {
  beforeEach(async () => {
    await fs.promises.mkdir(tempUploadsDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true })
  })

  it('removes stale chunk dirs and orphaned .assembled files', async () => {
    const staleDir = path.join(tempUploadsDir, '11111111-1111-1111-1111-111111111111')
    const freshDir = path.join(tempUploadsDir, '22222222-2222-2222-2222-222222222222')
    const staleAssembled = path.join(tempUploadsDir, '33333333-3333-3333-3333-333333333333.assembled')
    const freshAssembled = path.join(tempUploadsDir, '44444444-4444-4444-4444-444444444444.assembled')

    await fs.promises.mkdir(staleDir)
    await fs.promises.mkdir(freshDir)
    await fs.promises.writeFile(staleAssembled, 'orphan')
    await fs.promises.writeFile(freshAssembled, 'in-flight')

    const now = Date.now()
    const old = new Date(now - 2 * 60 * 60 * 1000)
    await fs.promises.utimes(staleDir, old, old)
    await fs.promises.utimes(staleAssembled, old, old)

    await cleanupStaleTempUploads(60 * 60 * 1000, now)

    expect(fs.existsSync(staleDir)).toBe(false)
    expect(fs.existsSync(staleAssembled)).toBe(false)
    expect(fs.existsSync(freshDir)).toBe(true)
    expect(fs.existsSync(freshAssembled)).toBe(true)
  })
})

describe('MAX_UPLOAD_TOTAL_SIZE', () => {
  it('is 2 GiB', () => {
    expect(MAX_UPLOAD_TOTAL_SIZE).toBe(2 * 1024 * 1024 * 1024)
  })
})
