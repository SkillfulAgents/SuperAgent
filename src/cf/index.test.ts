import { describe, expect, it } from 'vitest'
import { withClientAddress } from './index'

describe('withClientAddress', () => {
  it("replaces the address a client sent with Cloudflare's", () => {
    const request = withClientAddress(new Request('https://org.example.com/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.1' },
      body: '{"provider":"platform"}',
    }))

    expect(request.headers.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(request.headers.get('x-real-ip')).toBeNull()
    expect(request.method).toBe('POST')
  })

  it('keeps the body', async () => {
    const request = withClientAddress(new Request('https://org.example.com/api/agents', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      body: '{"name":"Sales"}',
    }))

    expect(await request.text()).toBe('{"name":"Sales"}')
  })

  it('leaves a request without cf-connecting-ip as it is', () => {
    const original = new Request('https://org.example.com/api/agents', { headers: { 'x-forwarded-for': '198.51.100.1' } })

    expect(withClientAddress(original)).toBe(original)
  })
})
