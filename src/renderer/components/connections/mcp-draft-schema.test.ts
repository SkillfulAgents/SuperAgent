import { describe, it, expect } from 'vitest'
import { mcpDraftSchema } from './mcp-draft-schema'

const valid = {
  sourceSlug: 'custom',
  name: 'Granola',
  url: 'https://mcp.granola.ai/mcp',
  authType: 'none' as const,
  token: '',
}

describe('mcpDraftSchema', () => {
  it('accepts a complete no-auth draft', () => {
    const r = mcpDraftSchema.safeParse(valid)
    expect(r.success).toBe(true)
  })

  it('accepts an oauth draft without a token', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, authType: 'oauth' })
    expect(r.success).toBe(true)
  })

  it('accepts a bearer draft with a non-empty token', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, authType: 'bearer', token: 'sk-abc' })
    expect(r.success).toBe(true)
  })

  it('rejects a bearer draft with an empty token', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, authType: 'bearer', token: '' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(['token'])
      expect(r.error.issues[0].message).toMatch(/bearer token/i)
    }
  })

  it('rejects a bearer draft with a whitespace-only token', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, authType: 'bearer', token: '   ' })
    expect(r.success).toBe(false)
  })

  it('rejects an http:// URL on a non-loopback host (must be https)', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, url: 'http://mcp.granola.ai/mcp' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/https/i)
    }
  })

  it('accepts http://localhost (dev-loop carve-out)', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, url: 'http://localhost:8000/mcp' })
    expect(r.success).toBe(true)
  })

  it('accepts http://127.0.0.1 (dev-loop carve-out)', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, url: 'http://127.0.0.1:9877/mcp' })
    expect(r.success).toBe(true)
  })

  it('rejects a URL missing the scheme', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, url: 'mcp.granola.ai/mcp' })
    expect(r.success).toBe(false)
  })

  it('rejects an empty name', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, name: '' })
    expect(r.success).toBe(false)
  })

  it('rejects a whitespace-only name', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, name: '   ' })
    expect(r.success).toBe(false)
  })

  it('rejects an empty url', () => {
    const r = mcpDraftSchema.safeParse({ ...valid, url: '' })
    expect(r.success).toBe(false)
  })

  it('trims name and url on the parsed output', () => {
    const r = mcpDraftSchema.safeParse({
      ...valid,
      name: '  Granola  ',
      url: '  https://mcp.granola.ai/mcp  ',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.name).toBe('Granola')
      expect(r.data.url).toBe('https://mcp.granola.ai/mcp')
    }
  })
})
