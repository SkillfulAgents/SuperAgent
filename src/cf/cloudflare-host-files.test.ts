import { describe, expect, it } from 'vitest'
import { CloudflareBlobStore, CloudflareUploadByteStore } from './cloudflare-host-files'
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

describe('CloudflareUploadByteStore', () => {
  it("stores a chunk, streams it back and removes it", async () => {
    const store = new CloudflareUploadByteStore(memoryR2Bucket())

    expect(await store.stream('uploads/user-1/upload-1/chunk-1')).toBeNull()
    await store.put('uploads/user-1/upload-1/chunk-1', bytes('first half of the report'))
    expect(await new Response((await store.stream('uploads/user-1/upload-1/chunk-1'))!).text()).toBe('first half of the report')

    await store.delete('uploads/user-1/upload-1/chunk-1')
    await store.delete('uploads/user-1/upload-1/chunk-1')
    expect(await store.stream('uploads/user-1/upload-1/chunk-1')).toBeNull()
  })

  it('lists every chunk under a prefix with its size, across pages, and nothing else in the bucket', async () => {
    const bucket = memoryR2Bucket(2)
    const store = new CloudflareUploadByteStore(bucket)
    await bucket.put('blobs/model-icons/a.svg', bytes('<svg/>'))
    await store.put('uploads/user-1/upload-1/chunk-1', bytes('12345'))
    await store.put('uploads/user-1/upload-1/chunk-2', bytes('123'))
    await store.put('uploads/user-2/upload-9/chunk-1', bytes('1'))

    expect(await store.list('uploads/')).toEqual([
      { key: 'uploads/user-1/upload-1/chunk-1', size: 5 },
      { key: 'uploads/user-1/upload-1/chunk-2', size: 3 },
      { key: 'uploads/user-2/upload-9/chunk-1', size: 1 },
    ])
    expect(await store.list('uploads/user-2/')).toEqual([{ key: 'uploads/user-2/upload-9/chunk-1', size: 1 }])
    expect(await store.list('')).toHaveLength(3)
  })

  it('streams the chunks of an upload one after another, and fails on a chunk of another size', async () => {
    const store = new CloudflareUploadByteStore(memoryR2Bucket())
    await store.put('uploads/user-1/upload-1/chunk-1', bytes('first half, '))
    await store.put('uploads/user-1/upload-1/chunk-2', bytes('second half'))
    const parts = [
      { key: 'uploads/user-1/upload-1/chunk-1', size: 12 },
      { key: 'uploads/user-1/upload-1/chunk-2', size: 11 },
    ]

    expect(await new Response(store.streamInOrder(parts)).text()).toBe('first half, second half')
    await expect(new Response(store.streamInOrder([{ ...parts[0], size: 5 }])).text()).rejects.toThrow()
  })

  it('refuses a key outside the uploads prefix', async () => {
    const store = new CloudflareUploadByteStore(memoryR2Bucket())

    await expect(store.put('blobs/model-icons/a.svg', bytes('x'))).rejects.toThrow('Invalid upload bytes key')
    await expect(store.stream('uploads/../blobs/a')).rejects.toThrow('Invalid upload bytes key')
  })
})
