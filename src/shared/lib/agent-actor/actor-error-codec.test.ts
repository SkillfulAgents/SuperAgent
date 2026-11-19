import { describe, expect, it } from 'vitest'
import { UploadTooLargeError } from '@shared/lib/utils/chunked-upload'
import { decodeActorError, encodeActorError } from './actor-error-codec'

describe('actor error codec', () => {
  it('rebuilds an upload too large as its own class, with its fields and its message', () => {
    const thrown = new UploadTooLargeError(20 * 1024 * 1024, 16 * 1024 * 1024)
    thrown.message = 'uploads/video.mp4 is larger than 16 MB; start the agent and send the file again'

    const decoded = decodeActorError(structuredClone(encodeActorError(thrown)))

    expect(decoded).toBeInstanceOf(UploadTooLargeError)
    expect(decoded).toMatchObject({ name: 'UploadTooLargeError', size: 20 * 1024 * 1024, maxBytes: 16 * 1024 * 1024 })
    expect(decoded.message).toBe('uploads/video.mp4 is larger than 16 MB; start the agent and send the file again')
  })
})
