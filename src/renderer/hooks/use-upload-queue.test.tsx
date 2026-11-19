// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useUploadQueue, type UploadQueueOptions } from './use-upload-queue'
import type { Attachment, FileAttachment, FolderAttachment } from '@renderer/components/messages/attachment-preview'
import { zipFolderFiles } from '@renderer/lib/file-utils'
import { HttpError } from '@renderer/lib/http-error'
import { HEIC_PREVIEW_MAX_SOURCE_BYTES } from '@shared/lib/utils/heic-preview'

vi.mock('@renderer/lib/error-reporting', () => ({ captureRendererException: vi.fn() }))
vi.mock('@renderer/lib/file-utils', () => ({
  zipFolderFiles: vi.fn().mockResolvedValue(new Blob(['zip'])),
}))

function fileAttachment(id: string): FileAttachment {
  return { type: 'file', id, file: new File(['x'], `${id}.txt`) }
}

function folderAttachment(id: string, extras: Partial<FolderAttachment> = {}): FolderAttachment {
  return {
    type: 'folder',
    id,
    folderName: id,
    files: [{ file: new File(['x'], 'f.txt'), relativePath: 'f.txt' }],
    totalSize: 1,
    ...extras,
  }
}

// Mount chips have no `upload`; narrow before reading it so the assertions typecheck.
function uploadOf(a: Attachment | undefined) {
  return a && (a.type === 'file' || a.type === 'folder') ? a.upload : undefined
}

// Drives real attachment state so the queue's ref reads what the UI would.
function useHarness(
  uploadFile: UploadQueueOptions['uploadFile'],
  initial: Attachment[] = [],
  uploadFolder: UploadQueueOptions['uploadFolder'] = vi.fn(),
  agentSlug = 'agent-a',
) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const queue = useUploadQueue({
    agentSlug,
    attachmentsRef,
    updateAttachment: (id, patch) => setAttachments((p) => p.map((a) => (a.id === id ? { ...a, ...patch } : a))),
    removeAttachment: (id) => setAttachments((p) => p.filter((a) => a.id !== id)),
    clearAttachments: () => setAttachments([]),
    uploadFile,
    uploadFolder,
  })
  return { attachments, setAttachments, queue }
}

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useUploadQueue', () => {
  it('uploads one at a time in enqueue order and marks done with the path', async () => {
    const d1 = deferred<{ path: string }>(), d2 = deferred<{ path: string }>()
    const uploadFile = vi.fn()
      .mockImplementationOnce(({ onProgress }) => { onProgress?.({ phase: 'uploading', percent: 40 }); return d1.promise })
      .mockReturnValueOnce(d2.promise)
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a'), fileAttachment('b')]))
    act(() => { result.current.queue.enqueue(fileAttachment('a')); result.current.queue.enqueue(fileAttachment('b')) })
    await act(async () => {})
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(uploadOf(result.current.attachments[0])).toMatchObject({ status: 'uploading', percent: 40 })
    expect(uploadOf(result.current.attachments[1])?.status).toBe('queued')
    await act(async () => { d1.resolve({ path: '/a' }) })
    expect(uploadOf(result.current.attachments[0])).toMatchObject({ status: 'done', path: '/a', agentSlug: 'agent-a' })
    expect(result.current.queue.pathFor('a')).toEqual({ path: '/a', agentSlug: 'agent-a' })
    expect(uploadFile).toHaveBeenCalledTimes(2)
    await act(async () => { d2.resolve({ path: '/b' }) })
    expect(uploadOf(result.current.attachments[1])?.status).toBe('done')
  })

  it('uses the uploaded inline URL to preview a HEIC attachment', async () => {
    const attachment: FileAttachment = {
      type: 'file',
      id: 'photo',
      file: new File(['heic'], 'photo.heic', { type: 'image/heic' }),
    }
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/uploads/photo-1.heic' })
    const { result } = renderHook(() => useHarness(uploadFile, [attachment]))

    await act(async () => { result.current.queue.enqueue(attachment) })

    expect(result.current.attachments[0]).toMatchObject({
      preview: expect.stringContaining('/api/agents/agent-a/files/uploads/photo-1.heic?inline=true'),
    })
  })

  it('keeps an oversized HEIC attachment as a file chip after upload', async () => {
    const file = new File(['heic'], 'photo.heic', { type: 'image/heic' })
    Object.defineProperty(file, 'size', { value: HEIC_PREVIEW_MAX_SOURCE_BYTES + 1 })
    const attachment: FileAttachment = { type: 'file', id: 'photo', file }
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/uploads/photo-1.heic' })
    const { result } = renderHook(() => useHarness(uploadFile, [attachment]))

    await act(async () => { result.current.queue.enqueue(attachment) })

    expect(result.current.attachments[0]).toHaveProperty('preview', undefined)
  })

  it('a rejection sets error, clears upload, and the next chip still starts', async () => {
    const uploadFile = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ path: '/b' })
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a'), fileAttachment('b')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')); result.current.queue.enqueue(fileAttachment('b')) })
    expect(result.current.attachments[0]).toMatchObject({ error: 'boom', upload: undefined })
    expect(result.current.queue.pathFor('a')).toBeUndefined()
    expect(uploadOf(result.current.attachments[1])?.status).toBe('done')
  })

  it('an AbortError after remove is ignored', async () => {
    const d = deferred<{ path: string }>()
    const uploadFile = vi.fn().mockImplementation(({ signal }) => { signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; d.reject(e) }); return d.promise })
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    await act(async () => { result.current.queue.remove('a') })
    expect(result.current.attachments).toEqual([])
  })

  it('drops an upload that finishes after its chip was removed', async () => {
    const d = deferred<{ path: string }>()
    const uploadFile = vi.fn().mockReturnValueOnce(d.promise)
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    await act(async () => { result.current.queue.remove('a') })
    await act(async () => { d.resolve({ path: '/a' }) })
    expect(result.current.queue.pathFor('a')).toBeUndefined()
    expect(result.current.attachments).toEqual([])
  })

  it('retryAndWait re-uploads errored chips and includes a chip enqueued mid-wait', async () => {
    const d2 = deferred<{ path: string }>()
    const uploadFile = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))      // first attempt of a
      .mockResolvedValueOnce({ path: '/a' })           // retry of a
      .mockReturnValueOnce(d2.promise)                 // b, dropped mid-wait
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    expect(result.current.attachments[0].error).toBe('boom')
    let outcome: { ok: boolean } | undefined
    await act(async () => {
      const p = result.current.queue.retryAndWait().then((o) => { outcome = o })
      result.current.setAttachments((prev) => [...prev, fileAttachment('b')])
      await Promise.resolve()
      result.current.queue.enqueue(fileAttachment('b'))
      d2.resolve({ path: '/b' })
      await p
    })
    expect(outcome).toEqual({ ok: true })
    expect(result.current.attachments.map((a) => uploadOf(a)?.path)).toEqual(['/a', '/b'])
  })

  it('retryAndWait returns ok:false when a retry fails again', async () => {
    const uploadFile = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    let outcome: { ok: boolean } | undefined
    await act(async () => { outcome = await result.current.queue.retryAndWait() })
    expect(outcome).toEqual({ ok: false })
    expect(result.current.attachments[0].error).toBe('boom')
  })

  it('waitIdle reports a failure that arrives while the caller is waiting without retrying it', async () => {
    const d = deferred<{ path: string }>()
    const uploadFile = vi.fn().mockReturnValueOnce(d.promise)
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    await act(async () => {
      const waiting = result.current.queue.waitIdle()
      d.reject(new Error('offline'))
      expect(await waiting).toEqual({ ok: false })
    })
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(result.current.attachments[0]).toMatchObject({ error: 'offline', errorRetryable: true })
    await act(async () => { result.current.queue.remove('a') })
    expect(await result.current.queue.waitIdle()).toEqual({ ok: true })
  })

  it.each([409, 413])('keeps an HTTP %i failure for removal without retrying on submit or a retry callback', async (status) => {
    const uploadFile = vi.fn().mockRejectedValue(new HttpError(status, 'Upload rejected'))
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    await act(async () => {
      result.current.queue.retry('a')
      expect(await result.current.queue.retryAndWait()).toEqual({ ok: false })
    })
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(result.current.attachments[0]).toMatchObject({ error: 'Upload rejected', errorRetryable: false })
  })

  it.each([408, 429, 503])('allows retrying an HTTP %i upload failure', async (status) => {
    const uploadFile = vi.fn().mockRejectedValueOnce(new HttpError(status)).mockResolvedValueOnce({ path: '/a' })
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    expect(result.current.attachments[0]).toMatchObject({ errorRetryable: true })
    await act(async () => { expect(await result.current.queue.retryAndWait()).toEqual({ ok: true }) })
    expect(uploadFile).toHaveBeenCalledTimes(2)
    expect(uploadOf(result.current.attachments[0])?.path).toBe('/a')
  })

  it('clear aborts the in-flight upload', async () => {
    const abort = vi.fn()
    const uploadFile = vi.fn().mockImplementation(({ signal }) => { signal.addEventListener('abort', abort); return new Promise(() => {}) })
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    act(() => { result.current.queue.clear() })
    expect(abort).toHaveBeenCalled()
    expect(result.current.attachments).toEqual([])
  })

  it('requeueAll aborts and re-enqueues every file/folder chip under the new agent', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ path: '/p' })
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    expect(uploadOf(result.current.attachments[0])?.status).toBe('done')
    await act(async () => { result.current.queue.requeueAll() })
    expect(uploadFile).toHaveBeenCalledTimes(2)
  })

  it('a job whose generation is stale leaves the new generation alone', async () => {
    const d = deferred<{ path: string }>()
    const uploadFile = vi.fn().mockReturnValueOnce(d.promise).mockResolvedValueOnce({ path: '/new' })
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')]))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    await act(async () => { result.current.queue.requeueAll() }) // aborts the first, enqueues a second
    await act(async () => { d.reject(new Error('late failure from the old job')) })
    expect(uploadOf(result.current.attachments[0])).toMatchObject({ status: 'done', path: '/new' })
    expect(result.current.attachments[0].error).toBeUndefined()
  })

  it('an Electron folder copies on the server and marks done without a percent', async () => {
    const uploadFolder = vi.fn().mockResolvedValue({ path: '/workspace/docs' })
    const uploadFile = vi.fn()
    const folder = folderAttachment('docs', { folderPath: '/host/docs' })
    const { result } = renderHook(() => useHarness(uploadFile, [folder], uploadFolder))
    await act(async () => { result.current.queue.enqueue(folder) })
    expect(uploadFolder).toHaveBeenCalledWith({ sourcePath: '/host/docs' })
    expect(uploadFile).not.toHaveBeenCalled()
    expect(uploadOf(result.current.attachments[0])).toMatchObject({ status: 'done', path: '/workspace/docs', agentSlug: 'agent-a' })
    expect(uploadOf(result.current.attachments[0])?.percent).toBeUndefined()
  })

  it('a browser folder zips then uploads the archive', async () => {
    const uploadFolder = vi.fn()
    const uploadFile = vi.fn().mockResolvedValue({ path: '/workspace/docs.zip' })
    const folder = folderAttachment('docs')
    const { result } = renderHook(() => useHarness(uploadFile, [folder], uploadFolder))
    await act(async () => { result.current.queue.enqueue(folder) })
    expect(zipFolderFiles).toHaveBeenCalledWith(folder.files)
    expect(uploadFolder).not.toHaveBeenCalled()
    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ name: 'docs.zip', type: 'application/zip' }),
    }))
    expect(uploadOf(result.current.attachments[0])).toMatchObject({ status: 'done', path: '/workspace/docs.zip' })
  })

  it('does not start an upload when the agent slug is empty', async () => {
    const uploadFile = vi.fn()
    const { result } = renderHook(() => useHarness(uploadFile, [fileAttachment('a')], vi.fn(), ''))
    await act(async () => { result.current.queue.enqueue(fileAttachment('a')) })
    expect(uploadFile).not.toHaveBeenCalled()
    expect(uploadOf(result.current.attachments[0])?.status).toBe('queued')
  })
})
