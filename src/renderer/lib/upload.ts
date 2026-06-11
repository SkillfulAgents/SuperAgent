import { apiFetch } from '@renderer/lib/api'

// 50MB — keeps each request under Cloudflare's 100MB request-body limit so
// large files don't 413 at the edge before reaching the API.
export const UPLOAD_CHUNK_SIZE = 50 * 1024 * 1024

export type UploadProgress = { phase: 'uploading' | 'processing'; percent: number }

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json()
    return (data && typeof data.error === 'string' && data.error) || fallback
  } catch {
    return fallback
  }
}

interface UploadOptions {
  /** Endpoint that accepts both single-request (`file`) and chunked (`chunk`) uploads. */
  url: string
  file: File
  /** Extra multipart fields sent with every request (e.g. `mode`, `relativePath`). */
  fields?: Record<string, string>
  onProgress?: (p: UploadProgress) => void
}

/**
 * Upload a file to an endpoint that supports chunked uploads. Files at or below
 * UPLOAD_CHUNK_SIZE go in a single request; larger files are sliced so each
 * request stays under Cloudflare's 100MB limit. The endpoint's JSON response
 * (from the single/final request) is returned. On failure the backend's error
 * message is surfaced so callers can show it to the user.
 */
export async function uploadFileChunked<T>({ url, file, fields = {}, onProgress }: UploadOptions): Promise<T> {
  if (file.size <= UPLOAD_CHUNK_SIZE) {
    const formData = new FormData()
    formData.append('file', file)
    for (const [k, v] of Object.entries(fields)) formData.append(k, v)

    onProgress?.({ phase: 'uploading', percent: 100 })
    const res = await apiFetch(url, { method: 'POST', body: formData })
    if (!res.ok) throw new Error(await readError(res, 'Upload failed. Please try again.'))
    onProgress?.({ phase: 'processing', percent: 100 })
    return res.json() as Promise<T>
  }

  const uploadId = crypto.randomUUID()
  const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_SIZE)

  for (let i = 0; i < totalChunks; i++) {
    const start = i * UPLOAD_CHUNK_SIZE
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, file.size)
    const chunkBlob = file.slice(start, end)

    const formData = new FormData()
    formData.append('chunk', chunkBlob)
    formData.append('uploadId', uploadId)
    formData.append('chunkIndex', String(i))
    formData.append('totalChunks', String(totalChunks))
    formData.append('filename', file.name)
    for (const [k, v] of Object.entries(fields)) formData.append(k, v)

    onProgress?.({ phase: 'uploading', percent: (i / totalChunks) * 100 })

    const res = await apiFetch(url, { method: 'POST', body: formData })
    if (!res.ok) throw new Error(await readError(res, 'Upload failed. Please try again.'))

    // The final chunk returns the assembled result.
    if (i === totalChunks - 1) {
      onProgress?.({ phase: 'processing', percent: 100 })
      return res.json() as Promise<T>
    }
  }

  throw new Error('Unexpected end of chunked upload')
}
