import { describe, expect, it } from 'vitest'
import { CloudflareBlobStore } from './cloudflare-blob-store'
import { memoryR2Bucket } from './testing/memory-r2-bucket'

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (value: Uint8Array | null) => (value ? new TextDecoder().decode(value) : null)

describe('CloudflareBlobStore', () => {
  it('keeps a blob under its key, replaces it and removes it', async () => {
    const bucket = memoryR2Bucket()
    const store = new CloudflareBlobStore(bucket)

    expect(await store.get('profile-photos/dana.png')).toBeNull()
    await store.put('profile-photos/dana.png', bytes('first photo'))
    await store.put('profile-photos/dana.png', bytes('second photo'))
    expect(text(await store.get('profile-photos/dana.png'))).toBe('second photo')
    // Blobs have their own prefix in the bucket.
    expect(bucket.keys()).toEqual(['blobs/profile-photos/dana.png'])

    await store.delete('profile-photos/dana.png')
    await store.delete('profile-photos/dana.png')
    expect(await store.get('profile-photos/dana.png')).toBeNull()
  })

  it('refuses a key that climbs out of its prefix', async () => {
    const store = new CloudflareBlobStore(memoryR2Bucket())

    await expect(store.put('../uploads/chunk', bytes('x'))).rejects.toThrow('Invalid blob key')
    await expect(store.get('model-icons//a.svg')).rejects.toThrow('Invalid blob key')
  })
})
