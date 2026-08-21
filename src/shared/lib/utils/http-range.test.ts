import { describe, it, expect } from 'vitest'
import { parseByteRange } from './http-range'

describe('parseByteRange', () => {
  const SIZE = 1000

  it('parses a fully-specified range', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 })
    expect(parseByteRange('bytes=200-999', SIZE)).toEqual({ start: 200, end: 999 })
  })

  it('treats an open-ended range as running to the last byte', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 })
  })

  it('clamps an end past the file size', () => {
    expect(parseByteRange('bytes=0-5000', SIZE)).toEqual({ start: 0, end: 999 })
  })

  it('resolves a suffix range to the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 })
  })

  it('clamps a suffix range larger than the file to the whole file', () => {
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseByteRange('  bytes=0-9 ', SIZE)).toEqual({ start: 0, end: 9 })
  })

  it('rejects malformed headers', () => {
    expect(parseByteRange('bytes=', SIZE)).toBeNull()
    expect(parseByteRange('bytes=abc-def', SIZE)).toBeNull()
    expect(parseByteRange('items=0-10', SIZE)).toBeNull()
    expect(parseByteRange('0-10', SIZE)).toBeNull()
  })

  it('rejects multi-range requests (unsupported)', () => {
    expect(parseByteRange('bytes=0-10,20-30', SIZE)).toBeNull()
  })

  it('rejects an unsatisfiable start at or beyond the file size', () => {
    expect(parseByteRange('bytes=1000-1100', SIZE)).toBeNull()
    expect(parseByteRange('bytes=2000-', SIZE)).toBeNull()
  })

  it('rejects an inverted range', () => {
    expect(parseByteRange('bytes=500-100', SIZE)).toBeNull()
  })

  it('rejects a zero-length suffix range', () => {
    expect(parseByteRange('bytes=-0', SIZE)).toBeNull()
  })

  it('treats every range against an empty file as unsatisfiable', () => {
    expect(parseByteRange('bytes=0-0', 0)).toBeNull()
    expect(parseByteRange('bytes=-100', 0)).toBeNull()
  })
})
