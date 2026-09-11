import { describe, it, expect } from 'vitest'
import { parsePageCursor, formatPageCursor } from './session-page-cursor'

describe('page cursor codec', () => {
  it('round-trips an id with an offset', () => {
    const cursor = formatPageCursor('5c1f0c9e-8f1e-4d0a-9d2b-3a7b1c2d3e4f', 123456)
    expect(cursor).toBe('5c1f0c9e-8f1e-4d0a-9d2b-3a7b1c2d3e4f:123456')
    expect(parsePageCursor(cursor)).toEqual({
      id: '5c1f0c9e-8f1e-4d0a-9d2b-3a7b1c2d3e4f',
      offset: 123456,
    })
  })

  it('treats a bare uuid as an id-only cursor (legacy clients)', () => {
    expect(parsePageCursor('5c1f0c9e-8f1e-4d0a-9d2b-3a7b1c2d3e4f')).toEqual({
      id: '5c1f0c9e-8f1e-4d0a-9d2b-3a7b1c2d3e4f',
    })
  })

  it('formats id-only when there is no usable offset', () => {
    expect(formatPageCursor('abc', undefined)).toBe('abc')
    expect(formatPageCursor('abc', -1)).toBe('abc')
    expect(formatPageCursor('abc', 1.5)).toBe('abc')
    expect(formatPageCursor('abc', 0)).toBe('abc:0')
  })

  it('does not mistake other colon suffixes for an offset', () => {
    expect(parsePageCursor('abc:')).toEqual({ id: 'abc:' })
    expect(parsePageCursor('abc:12x')).toEqual({ id: 'abc:12x' })
    expect(parsePageCursor('abc:-5')).toEqual({ id: 'abc:-5' })
    // A digit run too long to be a safe integer is not an offset.
    expect(parsePageCursor('abc:1234567890123456')).toEqual({ id: 'abc:1234567890123456' })
    expect(parsePageCursor(':5')).toEqual({ id: ':5' })
  })
})
