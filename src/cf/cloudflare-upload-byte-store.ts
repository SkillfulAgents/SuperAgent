/**
 * The bytes of chunked uploads on R2, next to the local disk store of desktop and the Node host
 * (chunked-upload-bytes.ts): the chunks of one upload reach different isolates, and none has a
 * disk the next one sees. Each key is one object; every key already starts with `uploads/`.
 */
import type { R2Bucket } from 'cloudflare:workers'
import { UPLOAD_BYTES_PREFIX, type UploadByteStore } from '@shared/lib/utils/chunked-upload-bytes'

export class CloudflareUploadByteStore implements UploadByteStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(objectKey(key), bytes)
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    return (await this.bucket.get(objectKey(key)))?.body ?? null
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(objectKey(key))
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
}

function objectKey(key: string): string {
  const parts = key.startsWith(UPLOAD_BYTES_PREFIX) ? key.slice(UPLOAD_BYTES_PREFIX.length).split('/') : []
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid upload bytes key: ${key}`)
  }
  return key
}
