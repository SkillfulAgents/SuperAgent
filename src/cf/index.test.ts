import { describe, expect, it } from 'vitest'
import { deployAuthorized, withClientAddress } from './index'

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

  it('drops the address a client sent when Cloudflare names none', () => {
    const request = withClientAddress(new Request('https://org.example.com/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.1' },
      body: '{"provider":"platform"}',
    }))

    expect(request.headers.get('x-forwarded-for')).toBeNull()
    expect(request.headers.get('x-real-ip')).toBeNull()
  })
})

describe('deployAuthorized', () => {
  const step = (authorization?: string) => new Request('https://org.example.com/_deploy/prepare', { method: 'POST', headers: authorization ? { authorization } : {} })

  it('lets in only a request that carries the deploy secret', async () => {
    expect(await deployAuthorized(step('Bearer deploy-secret'), 'deploy-secret')).toBe(true)
    expect(await deployAuthorized(step('Bearer another-secret'), 'deploy-secret')).toBe(false)
    expect(await deployAuthorized(step('deploy-secret'), 'deploy-secret')).toBe(false)
    expect(await deployAuthorized(step(), 'deploy-secret')).toBe(false)
  })

  it('lets nobody in while no deploy secret is set', async () => {
    expect(await deployAuthorized(step('Bearer '), undefined)).toBe(false)
    expect(await deployAuthorized(step('Bearer '), '')).toBe(false)
  })
})
