import { getApiBaseUrl } from '@renderer/lib/env'
import { handleUnauthorizedResponse } from '@renderer/lib/api'

// 50MB — keeps each request under Cloudflare's 100MB request-body limit so
// large files don't 413 at the edge before reaching the API.
export const UPLOAD_CHUNK_SIZE = 50 * 1024 * 1024

// Between-progress-events stall bound (Uppy's XHRUpload default). Only the
// composer passes it; other callers leave the timer off because their server
// side does unbounded work after the last byte (template import).
export const UPLOAD_STALL_MS = 30_000

export type UploadProgress = { phase: 'uploading' | 'processing'; percent: number }

export class UploadStalledError extends Error {
  constructor(stallMs: number) {
    super(`Upload stalled for ${Math.round(stallMs / 1000)} seconds. Check your connection and retry.`)
    this.name = 'UploadStalledError'
  }
}

function abortError(): Error {
  const err = new Error('Upload aborted')
  err.name = 'AbortError'
  return err
}

interface UploadResponse {
  ok: boolean
  status: number
  json(): unknown
}

interface SendOptions {
  /** Fraction of the request body sent, 0..1. Multipart framing is included in the ratio. */
  onSent?: (fraction: number) => void
  signal?: AbortSignal
  stallMs: number
}

// XHR rather than fetch: fetch cannot report request-body progress, and
// upload.onprogress is the only browser API that does. Credentials stay
// same-origin (withCredentials=false) to match fetch's default; the browser
// writes the multipart Content-Type itself.
function sendUploadRequest(url: string, formData: FormData, { onSent, signal, stallMs }: SendOptions): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    // Recorded before abort(): onabort fires synchronously inside it, and the
    // reason decides whether the caller ignores the rejection (user removed
    // the chip) or surfaces it (we gave up on a stall).
    let terminal: Error | null = null
    let stallTimer: ReturnType<typeof setTimeout> | undefined

    const armStall = () => {
      if (!stallMs) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        terminal = new UploadStalledError(stallMs)
        xhr.abort()
      }, stallMs)
    }
    const settle = () => {
      if (stallTimer) clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onSignalAbort)
    }
    const onSignalAbort = () => {
      terminal = abortError()
      xhr.abort()
    }

    xhr.open('POST', `${getApiBaseUrl()}${url}`)
    xhr.withCredentials = false
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onSent?.(Math.min(1, e.loaded / e.total))
      armStall()
    }
    xhr.onload = () => {
      settle()
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: () => parseJson(xhr.responseText),
      })
    }
    xhr.onerror = () => {
      settle()
      reject(new Error('Upload failed. Please try again.'))
    }
    xhr.onabort = () => {
      settle()
      reject(terminal ?? abortError())
    }

    if (signal?.aborted) {
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', onSignalAbort)
    armStall()
    xhr.send(formData)
  })
}

// Named so a malformed body rejects at the caller's await rather than tripping
// the no-unhandled-throwing-builtins rule at the call site.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`Upload response was not JSON: ${(err as Error).message}`)
  }
}

function readError(res: UploadResponse, fallback: string): string {
  try {
    const data = res.json() as { error?: unknown }
    return (data && typeof data.error === 'string' && data.error) || fallback
  } catch {
    return fallback
  }
}

async function checkResponse(res: UploadResponse, url: string): Promise<void> {
  await handleUnauthorizedResponse(res.status, url)
  if (!res.ok) throw new Error(readError(res, 'Upload failed. Please try again.'))
}

interface UploadOptions {
  /** Endpoint that accepts both single-request (`file`) and chunked (`chunk`) uploads. */
  url: string
  file: File
  /** Extra multipart fields sent with every request (e.g. `mode`, `relativePath`). */
  fields?: Record<string, string>
  onProgress?: (p: UploadProgress) => void
  /** Aborts the in-flight request; the returned promise rejects with an AbortError. */
  signal?: AbortSignal
  /** Give up after this many ms without an upload-progress event. 0 (default) disables. */
  stallMs?: number
}

/**
 * Upload a file to an endpoint that supports chunked uploads. Files at or below
 * UPLOAD_CHUNK_SIZE go in a single request; larger files are sliced so each
 * request stays under Cloudflare's 100MB limit. The endpoint's JSON response
 * (from the single/final request) is returned. On failure the backend's error
 * message is surfaced so callers can show it to the user.
 */
export async function uploadFileChunked<T>({ url, file, fields = {}, onProgress, signal, stallMs = 0 }: UploadOptions): Promise<T> {
  const totalChunks = file.size <= UPLOAD_CHUNK_SIZE ? 1 : Math.ceil(file.size / UPLOAD_CHUNK_SIZE)
  const uploadId = totalChunks > 1 ? crypto.randomUUID() : null

  for (let i = 0; i < totalChunks; i++) {
    const start = i * UPLOAD_CHUNK_SIZE
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, file.size)

    const formData = new FormData()
    if (uploadId === null) {
      formData.append('file', file)
    } else {
      formData.append('chunk', file.slice(start, end))
      formData.append('uploadId', uploadId)
      formData.append('chunkIndex', String(i))
      formData.append('totalChunks', String(totalChunks))
      formData.append('filename', file.name)
    }
    for (const [k, v] of Object.entries(fields)) formData.append(k, v)

    // Framing overhead is in the XHR ratio, so map it onto this chunk's byte
    // span; a tiny file would otherwise report >100% of itself.
    const span = end - start
    const res = await sendUploadRequest(url, formData, {
      signal,
      stallMs,
      onSent: (fraction) => {
        const sent = start + fraction * span
        onProgress?.({ phase: 'uploading', percent: file.size > 0 ? Math.min(100, (sent / file.size) * 100) : 100 })
      },
    })
    await checkResponse(res, url)

    if (i === totalChunks - 1) {
      onProgress?.({ phase: 'processing', percent: 100 })
      return res.json() as T
    }
  }

  throw new Error('Unexpected end of chunked upload')
}
