import { describe, it, expect } from 'vitest'
import { LinkResponseSchema } from './link-response-schema'

describe('LinkResponseSchema', () => {
  it('accepts the documented envelope', () => {
    const parsed = LinkResponseSchema.parse({
      link_token: 'lk_abc',
      redirect_url: 'https://connect.composio.dev/link/lk_abc',
      expires_at: '2026-05-06T21:36:56.811Z',
      connected_account_id: 'ca_xyz',
    })
    expect(parsed.connected_account_id).toBe('ca_xyz')
    expect(parsed.redirect_url).toBe('https://connect.composio.dev/link/lk_abc')
  })

  it.each([
    'link_token',
    'redirect_url',
    'expires_at',
    'connected_account_id',
  ])('rejects when %s is missing', (field) => {
    const full = {
      link_token: 'lk_abc',
      redirect_url: 'https://connect.composio.dev/link/lk_abc',
      expires_at: '2026-05-06T21:36:56.811Z',
      connected_account_id: 'ca_xyz',
    } as Record<string, string>
    delete full[field]
    expect(() => LinkResponseSchema.parse(full)).toThrow()
  })

  it('rejects when a field is the wrong type', () => {
    expect(() =>
      LinkResponseSchema.parse({
        link_token: 123,
        redirect_url: 'https://connect.composio.dev/link/lk_abc',
        expires_at: '2026-05-06T21:36:56.811Z',
        connected_account_id: 'ca_xyz',
      })
    ).toThrow()
  })

  it('passes through unknown extra fields', () => {
    const parsed = LinkResponseSchema.parse({
      link_token: 'lk_abc',
      redirect_url: 'https://connect.composio.dev/link/lk_abc',
      expires_at: '2026-05-06T21:36:56.811Z',
      connected_account_id: 'ca_xyz',
      unexpected: 'ignored',
    })
    expect(parsed.connected_account_id).toBe('ca_xyz')
  })
})
