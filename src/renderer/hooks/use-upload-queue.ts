import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { zipFolderFiles } from '@renderer/lib/file-utils'
import { UPLOAD_STALL_MS, type UploadProgress } from '@renderer/lib/upload'
import type { Attachment, FileAttachment, FolderAttachment } from '@renderer/components/messages/attachment-preview'
import type { UploadPatch } from './use-attachments'

type Uploadable = FileAttachment | FolderAttachment

export interface UploadQueueOptions {
  agentSlug: string
  /** Rendered attachments; read only at user-driven moments (Send, agent change). */
  attachmentsRef: MutableRefObject<Attachment[]>
  updateAttachment: (id: string, patch: UploadPatch) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  uploadFile: (args: { file: File; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal; stallMs?: number }) => Promise<{ path: string }>
  uploadFolder: (args: { sourcePath: string }) => Promise<{ path: string }>
}

function isUploadable(a: Attachment): a is Uploadable {
  return a.type !== 'mount'
}

/**
 * Sequential upload queue for composer attachments. Imperative and ref-owned:
 * `enqueue` appends to a promise chain, so one upload runs at a time by
 * construction and a StrictMode double effect cannot start a second request.
 *
 * The chip object travels with the job rather than being looked up, because
 * the job can start (next microtask) before React has rendered the chip into
 * state. Cancellation is a generation counter (clear / agent change) plus a
 * per-id set (single remove), both checked when the job's turn comes.
 */
export function useUploadQueue(options: UploadQueueOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const controllersRef = useRef(new Map<string, AbortController>())
  const removedRef = useRef(new Set<string>())
  // Synchronous mirror of which chips carry an error. React state lags a
  // microtask behind the chain, so the waiter reads this, never the ref.
  const failedRef = useRef(new Set<string>())
  // Same lag: Send reads finished paths here when the chip has not committed yet.
  // Owner rides along so a stale chip cannot attach another agent's path.
  const pathsRef = useRef(new Map<string, { path: string; agentSlug: string }>())
  const generationRef = useRef(0)

  const uploadOne = useCallback(async (attachment: Uploadable, generation: number) => {
    const opts = optionsRef.current
    const { id } = attachment
    // A stale generation belongs to a cleared or re-targeted composer: leave
    // every marker alone, a newer job for the same id may be behind us.
    if (generation !== generationRef.current) return
    if (removedRef.current.has(id)) {
      removedRef.current.delete(id)
      return
    }
    const live = () => generation === generationRef.current && !removedRef.current.has(id)
    const controller = new AbortController()
    controllersRef.current.set(id, controller)
    const agentSlug = opts.agentSlug
    const onProgress = (p: UploadProgress) => {
      if (p.phase === 'uploading') opts.updateAttachment(id, { upload: { status: 'uploading', percent: p.percent, agentSlug } })
    }
    opts.updateAttachment(id, { upload: { status: 'uploading', agentSlug } })
    try {
      let result: { path: string }
      if (attachment.type === 'folder' && attachment.folderPath) {
        // Electron: server-side copy, no byte progress and no cancel
        result = await opts.uploadFolder({ sourcePath: attachment.folderPath })
      } else if (attachment.type === 'folder') {
        // Web fallback: zip in the browser, then upload the archive
        const zipBlob = await zipFolderFiles(attachment.files)
        const zipFile = new File([zipBlob], `${attachment.folderName}.zip`, { type: 'application/zip' })
        result = await opts.uploadFile({ file: zipFile, onProgress, signal: controller.signal, stallMs: UPLOAD_STALL_MS })
      } else {
        result = await opts.uploadFile({ file: attachment.file, onProgress, signal: controller.signal, stallMs: UPLOAD_STALL_MS })
      }
      if (!live()) return
      pathsRef.current.set(id, { path: result.path, agentSlug })
      opts.updateAttachment(id, { upload: { status: 'done', path: result.path, agentSlug } })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      if (!live()) return
      console.error('Failed to upload attachment:', error)
      captureRendererException(error, { tags: { source: 'attachment-upload' }, extra: { agentSlug } })
      failedRef.current.add(id)
      pathsRef.current.delete(id)
      opts.updateAttachment(id, { upload: undefined, error: error instanceof Error ? error.message : 'Upload failed. Please try again.' })
    } finally {
      controllersRef.current.delete(id)
    }
  }, [])

  const enqueue = useCallback((attachment: Uploadable) => {
    removedRef.current.delete(attachment.id)
    failedRef.current.delete(attachment.id)
    pathsRef.current.delete(attachment.id)
    const slug = optionsRef.current.agentSlug
    optionsRef.current.updateAttachment(attachment.id, { upload: { status: 'queued', agentSlug: slug }, error: undefined })
    // No agent yet (Quick Dispatch before the list loads): keep the chip waiting.
    // requeueAll runs when the slug arrives.
    if (!slug) return
    const generation = generationRef.current
    chainRef.current = chainRef.current.then(() => uploadOne(attachment, generation))
  }, [uploadOne])

  // Retry is user-driven, so the rendered list is current.
  const retry = useCallback((id: string) => {
    const a = optionsRef.current.attachmentsRef.current.find((x) => x.id === id)
    if (a && isUploadable(a)) enqueue(a)
  }, [enqueue])

  // Waits until the chain is idle, re-uploading errored chips first. A chip
  // enqueued during the wait extends the chain and is included.
  const retryAndWait = useCallback(async (): Promise<{ ok: boolean }> => {
    for (const a of optionsRef.current.attachmentsRef.current) {
      if (isUploadable(a) && a.error) enqueue(a)
    }
    let tail: Promise<void>
    do {
      tail = chainRef.current
      await tail
    } while (tail !== chainRef.current)
    return { ok: failedRef.current.size === 0 }
  }, [enqueue])

  const abortAll = useCallback(() => {
    generationRef.current += 1
    for (const c of controllersRef.current.values()) c.abort()
    controllersRef.current.clear()
    removedRef.current.clear()
    failedRef.current.clear()
    pathsRef.current.clear()
  }, [])

  const pathFor = useCallback((id: string) => pathsRef.current.get(id), [])

  const remove = useCallback((id: string) => {
    removedRef.current.add(id)
    failedRef.current.delete(id)
    pathsRef.current.delete(id)
    controllersRef.current.get(id)?.abort()
    controllersRef.current.delete(id)
    optionsRef.current.removeAttachment(id)
  }, [])

  const clear = useCallback(() => {
    abortAll()
    optionsRef.current.clearAttachments()
  }, [abortAll])

  // Agent changed under the composer (Quick Dispatch): every path belongs to
  // the old workspace, so start everything over.
  const requeueAll = useCallback(() => {
    abortAll()
    for (const a of optionsRef.current.attachmentsRef.current) {
      if (isUploadable(a)) enqueue(a)
    }
  }, [abortAll, enqueue])

  useEffect(() => abortAll, [abortAll])

  return { enqueue, retry, retryAndWait, pathFor, remove, clear, requeueAll }
}
