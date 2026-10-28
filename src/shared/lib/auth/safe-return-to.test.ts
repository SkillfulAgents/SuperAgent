import { describe, expect, it } from 'vitest'

import { sanitizeReturnTo } from './safe-return-to'

describe('sanitizeReturnTo', () => {
  it('accepts relative in-app paths', () => {
    expect(sanitizeReturnTo('/')).toBe('/')
    expect(sanitizeReturnTo('/agents')).toBe('/agents')
    expect(sanitizeReturnTo('/agents?tab=1')).toBe('/agents?tab=1')
  })

  it('rejects absolute and protocol-relative URLs', () => {
    expect(sanitizeReturnTo('https://evil.example')).toBe('/')
    expect(sanitizeReturnTo('//evil.example')).toBe('/')
    expect(sanitizeReturnTo('/\\evil.example')).toBe('/')
    expect(sanitizeReturnTo('/%2f%2fevil.example')).toBe('/')
  })

  it('falls back for empty or malformed input', () => {
    expect(sanitizeReturnTo(null)).toBe('/')
    expect(sanitizeReturnTo('')).toBe('/')
    expect(sanitizeReturnTo('agents')).toBe('/')
  })
})
