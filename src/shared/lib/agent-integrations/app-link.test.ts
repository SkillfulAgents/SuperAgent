import { afterEach, describe, it, expect, vi } from 'vitest'
import { resolveAppLinkContext, resolvePublicAppBaseUrl, withSessionUrl } from './app-link'

describe('resolveAppLinkContext', () => {
  const originalType = (process as { type?: string }).type
  const originalProtocol = process.env.SUPERAGENT_PROTOCOL
  const originalHostPublicUrl = process.env.HOST_PUBLIC_URL

  afterEach(() => {
    if (originalType === undefined) {
      delete (process as { type?: string }).type
    } else {
      ;(process as { type?: string }).type = originalType
    }
    if (originalProtocol === undefined) {
      delete process.env.SUPERAGENT_PROTOCOL
    } else {
      process.env.SUPERAGENT_PROTOCOL = originalProtocol
    }
    if (originalHostPublicUrl === undefined) {
      delete process.env.HOST_PUBLIC_URL
    } else {
      process.env.HOST_PUBLIC_URL = originalHostPublicUrl
    }
  })

  it('returns a desktop deeplink when process.type is browser', () => {
    ;(process as { type?: string }).type = 'browser'
    process.env.SUPERAGENT_PROTOCOL = 'superagent-dev'
    delete process.env.HOST_PUBLIC_URL

    expect(resolveAppLinkContext('my-agent')).toEqual({
      isDesktop: true,
      url: 'superagent-dev://agent/my-agent',
    })
  })

  it('falls back to the superagent scheme when SUPERAGENT_PROTOCOL is unset or empty', () => {
    ;(process as { type?: string }).type = 'browser'
    delete process.env.SUPERAGENT_PROTOCOL
    expect(resolveAppLinkContext('demo').url).toBe('superagent://agent/demo')

    process.env.SUPERAGENT_PROTOCOL = ''
    expect(resolveAppLinkContext('demo').url).toBe('superagent://agent/demo')
  })

  it('returns a web URL when HOST_PUBLIC_URL is set outside Electron', () => {
    delete (process as { type?: string }).type
    process.env.HOST_PUBLIC_URL = 'https://app.example.com/'

    expect(resolveAppLinkContext('my-agent')).toEqual({
      isDesktop: false,
      url: 'https://app.example.com/agents/my-agent',
    })
  })

  it('returns null web url when HOST_PUBLIC_URL is unset or empty', () => {
    delete (process as { type?: string }).type
    delete process.env.HOST_PUBLIC_URL
    expect(resolveAppLinkContext('demo')).toEqual({ isDesktop: false, url: null })

    process.env.HOST_PUBLIC_URL = ''
    expect(resolveAppLinkContext('demo')).toEqual({ isDesktop: false, url: null })

    process.env.HOST_PUBLIC_URL = '   '
    expect(resolveAppLinkContext('demo')).toEqual({ isDesktop: false, url: null })
  })

  it('URI-encodes the agent slug', () => {
    delete (process as { type?: string }).type
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    expect(resolveAppLinkContext('a/b c').url).toBe('https://app.example.com/agents/a%2Fb%20c')

    ;(process as { type?: string }).type = 'browser'
    process.env.SUPERAGENT_PROTOCOL = 'superagent'
    expect(resolveAppLinkContext('a/b c').url).toBe('superagent://agent/a%2Fb%20c')
  })
})

describe('withSessionUrl', () => {
  const desktop = { isDesktop: true, url: 'superagent://agent/demo' }
  const web = { isDesktop: false, url: 'https://host.example/agents/demo' }

  it('suffixes the session path onto a desktop link', () => {
    expect(withSessionUrl(desktop, 'sess-1')).toEqual({
      isDesktop: true,
      url: 'superagent://agent/demo/sessions/sess-1',
    })
  })

  it('suffixes the session path onto a web link', () => {
    expect(withSessionUrl(web, 'sess-1')?.url).toBe('https://host.example/agents/demo/sessions/sess-1')
  })

  it('strips trailing slashes from the base before appending', () => {
    expect(withSessionUrl({ isDesktop: false, url: 'https://host.example/agents/demo/' }, 's')?.url)
      .toBe('https://host.example/agents/demo/sessions/s')
  })

  it('URI-encodes the session id', () => {
    expect(withSessionUrl(desktop, 'a/b c')?.url).toBe('superagent://agent/demo/sessions/a%2Fb%20c')
  })

  it('passes through when the session id is missing or empty', () => {
    expect(withSessionUrl(desktop)).toBe(desktop)
    expect(withSessionUrl(desktop, '')).toBe(desktop)
  })

  it('passes through a null-url context (self-hosted cloud)', () => {
    const noUrl = { isDesktop: false, url: null }
    expect(withSessionUrl(noUrl, 'sess-1')).toBe(noUrl)
  })

  it('passes through undefined context', () => {
    expect(withSessionUrl(undefined, 'sess-1')).toBeUndefined()
  })
})


describe('resolvePublicAppBaseUrl', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('prefers the configured public URL and preserves path prefixes', () => {
    vi.stubEnv('HOST_PUBLIC_URL', ' https://public.example/gamut/// ')
    const request = new Request('http://internal:3000/path', { headers: { 'X-Forwarded-Host': 'proxy.example', 'X-Forwarded-Proto': 'https' } })
    expect(resolvePublicAppBaseUrl(request)).toBe('https://public.example/gamut')
  })
  it.each([
    [{ 'X-Forwarded-Host': 'public.example:8443', 'X-Forwarded-Proto': 'https' }, 'https://public.example:8443'],
    [{ 'X-Forwarded-Host': 'public.example, internal', 'X-Forwarded-Proto': 'https, http' }, 'https://public.example'],
    [{ 'X-Forwarded-Proto': 'https' }, 'https://internal:3000'],
    [{ 'X-Forwarded-Host': 'bad.example/path', 'X-Forwarded-Proto': 'javascript' }, 'http://internal:3000'],
    [{}, 'http://internal:3000'],
  ])('resolves forwarded origin %j without retaining the API path', (headers, expected) => {
    vi.stubEnv('HOST_PUBLIC_URL', '')
    expect(resolvePublicAppBaseUrl(new Request('http://internal:3000/api/setup', { headers }))).toBe(expected)
  })
  it('supports a direct local request without proxy headers', () => {
    vi.stubEnv('HOST_PUBLIC_URL', '')
    expect(resolvePublicAppBaseUrl('http://localhost:3000/path')).toBe('http://localhost:3000')
  })
})
