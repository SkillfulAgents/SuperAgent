import { describe, expect, it } from 'vitest'
import { CloudflareUploadByteStore } from './cloudflare-upload-byte-store'
import { memoryR2Bucket } from './testing/memory-r2-bucket'

const bytes = (text: string) => new TextEncoder().encode(text)

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

  it('refuses a key outside the uploads prefix', async () => {
    const store = new CloudflareUploadByteStore(memoryR2Bucket())

    await expect(store.put('blobs/model-icons/a.svg', bytes('x'))).rejects.toThrow('Invalid upload bytes key')
    await expect(store.stream('uploads/../blobs/a')).rejects.toThrow('Invalid upload bytes key')
  })
})
