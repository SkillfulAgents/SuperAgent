import { describe, expect, it } from 'vitest'
import { deployAuthorized, serveAppShell, servedByApi, withClientAddress, withoutClientAddress } from './index'

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

describe('withoutClientAddress', () => {
  it("drops every address header from a container's call, which the agent's own code wrote", async () => {
    const request = withoutClientAddress(new Request('http://host.internal/api/proxy/v1/messages', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.1', authorization: 'Bearer host-token' },
      body: '{"model":"sonnet"}',
    }))

    expect(request.headers.get('cf-connecting-ip')).toBeNull()
    expect(request.headers.get('x-forwarded-for')).toBeNull()
    expect(request.headers.get('x-real-ip')).toBeNull()
    expect(request.headers.get('authorization')).toBe('Bearer host-token')
    expect(await request.text()).toBe('{"model":"sonnet"}')
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

describe('servedByApi', () => {
  it('sends the API and the Platform sign-in launcher to the API, and every other path to the UI', () => {
    expect(servedByApi('/api/agents')).toBe(true)
    expect(servedByApi('/auth/platform/start')).toBe(true)
    expect(servedByApi('/agents/sales')).toBe(false)
    expect(servedByApi('/authors')).toBe(false)
    expect(servedByApi('/')).toBe(false)
  })
})

describe('serveAppShell', () => {
  const assets = (response: () => Response) => ({ fetch: async () => response() }) as unknown as Parameters<typeof serveAppShell>[1]
  const file = (type: string, status = 200) => () =>
    new Response(status === 304 ? null : 'body', { status, headers: { 'content-type': type, 'cache-control': 'public, max-age=0, must-revalidate', etag: '"abc"' } })

  it('lets a browser keep a hashed bundle for a year, and asks again for a file with a fixed name after an hour', async () => {
    const bundle = await serveAppShell(new Request('https://org.example.com/assets/index-DNAjeXyj.js'), assets(file('text/javascript')))
    expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(bundle.headers.get('etag')).toBe('"abc"')
    expect(await bundle.text()).toBe('body')

    const icon = await serveAppShell(new Request('https://org.example.com/service-icons/slack.svg'), assets(file('image/svg+xml')))
    expect(icon.headers.get('cache-control')).toBe('public, max-age=3600, must-revalidate')

    const unchanged = await serveAppShell(new Request('https://org.example.com/assets/index-DNAjeXyj.js'), assets(file('text/javascript', 304)))
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('does not let a browser keep a missing file', async () => {
    const missing = await serveAppShell(new Request('https://org.example.com/assets/gone.js'), assets(file('text/plain', 404)))
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('never lets a browser keep the HTML entry', async () => {
    const entry = await serveAppShell(new Request('https://org.example.com/agents/sales'), assets(() => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })))
    expect(entry.headers.get('cache-control')).toBe('no-cache')
  })
})

describe('the server facts of a Worker', () => {
  it('declare nothing on the host, so host git, folders and scripts are not offered', async () => {
    const { getServerCapabilities, getServerFacts } = await import('@shared/lib/facts/server-facts')
    expect(getServerCapabilities()).toEqual({
      canUseComputer: false,
      canRunHostScripts: false,
      canDriveUserChrome: false,
      canReadHostFoldersByPath: false,
      canFindHostApps: false,
      canRunHostGit: false,
    })
    expect(getServerFacts().capabilities).toEqual(getServerCapabilities())
  })
})
