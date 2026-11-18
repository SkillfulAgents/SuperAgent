/**
 * The org's host files on R2 (the HOST_FILES bucket), next to the data dir stores of desktop and the
 * Node host: a Worker has no disk that outlives a request, and the chunks of one upload reach
 * different isolates. Blobs (blob-store.ts) are one object each under `blobs/`; the bytes of
 * chunked uploads (chunked-upload-bytes.ts) are one object per key, and every key already starts
 * with `uploads/`.
 */
import type { R2Bucket } from 'cloudflare:workers'
import type { BlobStore } from '@shared/lib/blob-store/blob-store'
import { UPLOAD_BYTES_PREFIX, readPartsInOrder, type UploadByteStore, type UploadBytesPart } from '@shared/lib/utils/chunked-upload-bytes'

const BLOB_PREFIX = 'blobs/'

export class CloudflareBlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(blobObjectKey(key))
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(blobObjectKey(key), bytes)
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(blobObjectKey(key))
  }
}

/** The same keys the data dir store takes: parts with no `.`, `..` or backslash. */
function blobObjectKey(key: string): string {
  if (key.split('/').some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid blob key: ${key}`)
  }
  return BLOB_PREFIX + key
}

export class CloudflareUploadByteStore implements UploadByteStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(uploadObjectKey(key), bytes)
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    return (await this.bucket.get(uploadObjectKey(key)))?.body ?? null
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(uploadObjectKey(key))
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    // Never outside the uploads' own prefix: the bucket can hold other files.
    const within = prefix.startsWith(UPLOAD_BYTES_PREFIX) ? prefix : UPLOAD_BYTES_PREFIX
    const found: { key: string; size: number }[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix: within, cursor })
      for (const { key, size } of page.objects) if (key.startsWith(prefix)) found.push({ key, size })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return found
  }

  streamInOrder(parts: readonly UploadBytesPart[]): ReadableStream<Uint8Array> {
    return readPartsInOrder((key) => this.stream(key), parts)
  }
}

function uploadObjectKey(key: string): string {
  const parts = key.startsWith(UPLOAD_BYTES_PREFIX) ? key.slice(UPLOAD_BYTES_PREFIX.length).split('/') : []
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid upload bytes key: ${key}`)
  }
  return key
}
