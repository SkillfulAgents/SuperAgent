import { describe, it, expect } from 'vitest'
import { getDeliveredFileSize } from './deliver-file'

const REAL_RESULT = [
  'File "output/report.pdf" (12345 bytes) has been delivered to the user. They can now download it from the chat.',
  '',
  'Hint: If this is a file the user will access frequently…',
  '',
  'Delivered: {"sizeBytes":12345}',
].join('\n')

describe('getDeliveredFileSize', () => {
  it('reads the size from the Delivered contract line', () => {
    expect(getDeliveredFileSize(REAL_RESULT)).toBe(12345)
  })

  it('prefers the contract line over the prose', () => {
    const result = 'File "x" (999 bytes) has been delivered to the user.\n\nDelivered: {"sizeBytes":4096}'
    expect(getDeliveredFileSize(result)).toBe(4096)
  })

  it('reads a zero-byte file', () => {
    expect(getDeliveredFileSize('Delivered: {"sizeBytes":0}')).toBe(0)
  })

  it.each([
    ['malformed JSON', 'Delivered: {"sizeBytes":'],
    ['a size that is not a number', 'Delivered: {"sizeBytes":"big"}'],
    ['a negative size', 'Delivered: {"sizeBytes":-1}'],
    ['the key missing', 'Delivered: {"bytes":10}'],
  ])('ignores a contract line with %s', (_label, result) => {
    expect(getDeliveredFileSize(result)).toBeUndefined()
  })

  it('falls back to the prose for transcripts written before the contract line', () => {
    const legacy = 'File "output/report.pdf" (12345 bytes) has been delivered to the user. They can now download it.'
    expect(getDeliveredFileSize(legacy)).toBe(12345)
  })

  it('does not mistake a filename containing a byte count for the size', () => {
    const legacy = 'File "output/summary (5 bytes).txt" (61440 bytes) has been delivered to the user.'
    expect(getDeliveredFileSize(legacy)).toBe(61440)
  })

  it.each([
    ['an error result', 'Error: File not found at /workspace/x'],
    ['no result', null],
    ['an empty result', ''],
    ['an undefined result', undefined],
  ])('returns undefined for %s', (_label, result) => {
    expect(getDeliveredFileSize(result)).toBeUndefined()
  })
})
