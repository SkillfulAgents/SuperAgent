import { describe, it, expect } from 'vitest'
import { getDeliveredFileSize } from './deliver-file'

describe('getDeliveredFileSize', () => {
  it('reads the byte count from the container tool result', () => {
    expect(getDeliveredFileSize('File "output/report.pdf" (12345 bytes) has been delivered to the user.')).toBe(12345)
  })

  it('reads the persisted content-block array shape', () => {
    const result = [
      { type: 'text', text: 'File "test_files/sample_one.txt" (60 bytes) has been delivered to the user.\n\nHint: …' },
    ]
    expect(getDeliveredFileSize(result)).toBe(60)
  })

  it('reads the mock-client result shape', () => {
    expect(getDeliveredFileSize('File delivered successfully (size: 150 bytes)')).toBe(150)
  })

  it('returns undefined for errors, missing, or non-string results', () => {
    expect(getDeliveredFileSize('Error: File not found at /workspace/x')).toBeUndefined()
    expect(getDeliveredFileSize(undefined)).toBeUndefined()
    expect(getDeliveredFileSize({ size: 3 })).toBeUndefined()
  })
})
