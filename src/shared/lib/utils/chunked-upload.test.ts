import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import os from 'os'
import path from 'path'
import {
  MAX_UPLOAD_TOTAL_SIZE,
  UploadTooLargeError,
  cleanupStaleTempUploads,
  formatUploadTooLargeMessage,
  storeUploadChunk,
} from './chunked-upload'
import { setBlobStore } from '@shared/lib/blob-store/blob-store'
import { memoryBlobStore } from '@shared/lib/blob-store/testing/memory-blob-store'

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

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

describe('storeUploadChunk with a blob store', () => {
  const uploadId = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b'

  afterEach(() => setBlobStore(null))

  it('keeps chunks in the store, then streams them in order once the last arrives', async () => {
    const store = memoryBlobStore()
    setBlobStore(store)

    expect(await storeUploadChunk(uploadId, 1, 3, Buffer.from('second,'))).toEqual({ status: 'received' })
    expect(await storeUploadChunk(uploadId, 0, 3, Buffer.from('first,'))).toEqual({ status: 'received' })
    const result = await storeUploadChunk(uploadId, 2, 3, Buffer.from('third'))

    if (result.status !== 'stored') throw new Error(`expected stored, got ${result.status}`)
    expect(result.size).toBe(18)
    expect(await new Response(result.stream).text()).toBe('first,second,third')
    expect(fs.existsSync(path.join(tempUploadsDir, uploadId))).toBe(false)
    await result.discard()
    expect(store.keys()).toEqual([])
  })

  it('counts a re-sent chunk once, and drops every chunk when the upload grows past the limit', async () => {
    const store = memoryBlobStore()
    setBlobStore(store)

    await storeUploadChunk(uploadId, 0, 3, Buffer.alloc(40), 100)
    await storeUploadChunk(uploadId, 0, 3, Buffer.alloc(40), 100)
    await storeUploadChunk(uploadId, 1, 3, Buffer.alloc(40), 100)
    await expect(storeUploadChunk(uploadId, 2, 3, Buffer.alloc(40), 100)).rejects.toThrow(UploadTooLargeError)
    expect(store.keys()).toEqual([])
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

describe('formatUploadTooLargeMessage', () => {
  it('matches UploadTooLargeError message', () => {
    const message = formatUploadTooLargeMessage(150 * 1024 * 1024, 100 * 1024 * 1024)
    expect(message).toBe('File too large (150.0MB, max 100MB)')
    expect(new UploadTooLargeError(150 * 1024 * 1024, 100 * 1024 * 1024).message).toBe(message)
  })
})

describe('MAX_UPLOAD_TOTAL_SIZE', () => {
  it('is 2 GiB', () => {
    expect(MAX_UPLOAD_TOTAL_SIZE).toBe(2 * 1024 * 1024 * 1024)
  })
})
