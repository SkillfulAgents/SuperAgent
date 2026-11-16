/**
 * The blob store on R2, next to the data dir store of desktop and the Node host (blob-store.ts):
 * a Worker has no disk that outlives a request. Each key is one object under `blobs/`.
 */
import type { R2Bucket } from 'cloudflare:workers'
import type { BlobStore } from '@shared/lib/blob-store/blob-store'

const PREFIX = 'blobs/'

export class CloudflareBlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(objectKey(key))
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(objectKey(key), bytes)
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(objectKey(key))
  }
}

/** The same keys the data dir store takes: parts with no `.`, `..` or backslash. */
function objectKey(key: string): string {
  if (key.split('/').some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid blob key: ${key}`)
  }
  return PREFIX + key
}
