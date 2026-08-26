// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./env', () => ({ getApiBaseUrl: () => '' }))
vi.mock('./api', () => ({ handleUnauthorizedResponse: vi.fn().mockResolvedValue(undefined) }))

import { handleUnauthorizedResponse } from './api'
import { uploadFileChunked, UploadStalledError, UPLOAD_CHUNK_SIZE, UPLOAD_STALL_MS } from './upload'

// Minimal XHR double: records sends, lets a test drive progress/load/error/abort.
class FakeXHR {
  static instances: FakeXHR[] = []
  upload = { onprogress: null as null | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) }
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  onabort: null | (() => void) = null
  status = 0
  responseText = ''
  withCredentials = false
  aborted = false
  body: FormData | null = null
  open = vi.fn()
  setRequestHeader = vi.fn()
  send(body: FormData) { this.body = body; FakeXHR.instances.push(this) }
  abort() { this.aborted = true; this.onabort?.() }
  // helpers
  progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }) }
  respond(status: number, json: unknown) { this.status = status; this.responseText = JSON.stringify(json); this.onload?.() }
}

function file(size: number, name = 'f.bin'): File {
  return new File([new Uint8Array(size)], name)
}

beforeEach(() => {
  FakeXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('uploadFileChunked (XHR transport)', () => {
  it('sends one request for a small file and resolves the JSON body', async () => {
    const p = uploadFileChunked<{ path: string }>({ url: '/api/x', file: file(10), fields: { relativePath: 'a/b' } })
    const xhr = FakeXHR.instances[0]
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/x')
    expect(xhr.setRequestHeader).not.toHaveBeenCalled()
    expect(xhr.withCredentials).toBe(false)
    expect(xhr.body?.get('relativePath')).toBe('a/b')
    xhr.respond(200, { path: '/workspace/uploads/f.bin' })
    await expect(p).resolves.toEqual({ path: '/workspace/uploads/f.bin' })
  })

  it('maps progress onto the file size, ignoring multipart framing', async () => {
    const onProgress = vi.fn()
    const p = uploadFileChunked({ url: '/api/x', file: file(1000), onProgress })
    const xhr = FakeXHR.instances[0]
    xhr.progress(600, 1200) // half the framed body
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'uploading', percent: 50 })
    xhr.progress(1200, 1200)
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'uploading', percent: 100 })
    xhr.respond(200, {})
    await p
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'processing', percent: 100 })
  })

  it('aggregates progress across chunks', async () => {
    const onProgress = vi.fn()
    const p = uploadFileChunked({ url: '/api/x', file: file(UPLOAD_CHUNK_SIZE * 2), onProgress })
    FakeXHR.instances[0].progress(1, 2) // half of chunk 0 = 25% overall
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'uploading', percent: 25 })
    FakeXHR.instances[0].respond(200, { status: 'chunk_received' })
    await vi.advanceTimersByTimeAsync(0)
    FakeXHR.instances[1].progress(1, 2) // half of chunk 1 = 75% overall
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'uploading', percent: 75 })
    FakeXHR.instances[1].respond(200, { path: '/p' })
    await expect(p).resolves.toEqual({ path: '/p' })
  })

  it('rejects with UploadStalledError after stallMs without progress and aborts the XHR', async () => {
    const p = uploadFileChunked({ url: '/api/x', file: file(10), stallMs: UPLOAD_STALL_MS })
    const xhr = FakeXHR.instances[0]
    xhr.progress(1, 10)
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1)
    xhr.progress(2, 10) // resets
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1)
    expect(xhr.aborted).toBe(false)
    const rejected = expect(p).rejects.toBeInstanceOf(UploadStalledError) // attach before the timer fires
    await vi.advanceTimersByTimeAsync(1)
    expect(xhr.aborted).toBe(true)
    await rejected
  })

  it('never stalls when stallMs is 0', async () => {
    const p = uploadFileChunked({ url: '/api/x', file: file(10) })
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS * 10)
    expect(FakeXHR.instances[0].aborted).toBe(false)
    FakeXHR.instances[0].respond(200, {})
    await expect(p).resolves.toEqual({})
  })

  it('rejects with AbortError when the caller signal aborts', async () => {
    const ac = new AbortController()
    const p = uploadFileChunked({ url: '/api/x', file: file(10), signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeXHR.instances[0].aborted).toBe(true)
  })

  it('surfaces the backend error message on a non-2xx response', async () => {
    const p = uploadFileChunked({ url: '/api/x', file: file(10) })
    FakeXHR.instances[0].respond(413, { error: 'too big' })
    await expect(p).rejects.toThrow('too big')
  })

  it('uses the fallback message on a network error', async () => {
    const p = uploadFileChunked({ url: '/api/x', file: file(10) })
    FakeXHR.instances[0].onerror?.()
    await expect(p).rejects.toThrow('Upload failed. Please try again.')
  })

  it('calls handleUnauthorizedResponse on a 401', async () => {
    const p = uploadFileChunked({ url: '/api/x', file: file(10) })
    FakeXHR.instances[0].respond(401, { error: 'expired' })
    await expect(p).rejects.toThrow('expired')
    expect(handleUnauthorizedResponse).toHaveBeenCalledWith(401, '/api/x')
  })
})
