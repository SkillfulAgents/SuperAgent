import { describe, expect, it } from 'vitest'
import { mcpAuthHeader, parseAuthHeaderName } from './auth-header'

describe('parseAuthHeaderName', () => {
  it('treats an empty name as the default Authorization header', () => {
    expect(parseAuthHeaderName(undefined)).toEqual({ ok: true, value: null })
    expect(parseAuthHeaderName('  ')).toEqual({ ok: true, value: null })
  })

  it('accepts and trims a custom header name', () => {
    expect(parseAuthHeaderName(' X-Api-Key ')).toEqual({ ok: true, value: 'X-Api-Key' })
  })

  it('rejects invalid and transport-owned names', () => {
    expect(parseAuthHeaderName('X Api Key').ok).toBe(false)
    expect(parseAuthHeaderName('X-Api-Key: value').ok).toBe(false)
    expect(parseAuthHeaderName('mcp-session-id').ok).toBe(false)
    expect(parseAuthHeaderName('Host').ok).toBe(false)
  })
})

describe('mcpAuthHeader', () => {
  it('sends a bearer token by default', () => {
    expect(mcpAuthHeader('secret')).toEqual(['Authorization', 'Bearer secret'])
  })

  it('sends the key as is in a named header', () => {
    expect(mcpAuthHeader('dp_example_key', 'X-Api-Key')).toEqual(['X-Api-Key', 'dp_example_key'])
  })
})
