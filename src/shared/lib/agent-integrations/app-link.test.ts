import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { resolveAppLinkContext, resolvePublicAppBaseUrl, withSessionUrl } from './app-link'

const settings = vi.hoisted(() => ({ auth: { trustedOrigins: [] as string[] } }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => settings }))
beforeEach(() => { vi.stubEnv('TRUSTED_ORIGINS', ''); settings.auth.trustedOrigins = [] })
afterEach(() => vi.unstubAllEnvs())

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
  const forwarded = { 'X-Forwarded-Host': 'untrusted.example:8443', 'X-Forwarded-Proto': 'https' }
  it('prefers the configured public URL and preserves path prefixes', () => {
    vi.stubEnv('HOST_PUBLIC_URL', ' https://public.example/gamut/// ')
    vi.stubEnv('TRUSTED_ORIGINS', 'https://trusted.example')
    const request = new Request('http://internal:3000/path', { headers: forwarded })
    expect(resolvePublicAppBaseUrl(request)).toBe('https://public.example/gamut')
  })
  it('uses the first configured trusted origin for callbacks and integration links', () => {
    vi.stubEnv('HOST_PUBLIC_URL', '')
    vi.stubEnv('TRUSTED_ORIGINS', ' https://public.example/, https://second.example ')
    expect(resolvePublicAppBaseUrl(new Request('http://internal:3000/api/setup', { headers: forwarded }))).toBe('https://public.example')
    expect(resolveAppLinkContext('agent')).toEqual({ isDesktop: false, url: 'https://public.example/agents/agent' })
  })
  it('uses the same saved-settings fallback as authentication', () => {
    vi.stubEnv('HOST_PUBLIC_URL', '')
    settings.auth.trustedOrigins = ['https://settings.example/']
    expect(resolvePublicAppBaseUrl(new Request('http://internal:3000/api/setup', { headers: forwarded }))).toBe('https://settings.example')
  })
  it.each<Record<string, string>>([
    forwarded,
    { 'X-Forwarded-Host': 'public.example, internal', 'X-Forwarded-Proto': 'https, http' },
    { 'X-Forwarded-Proto': 'https' },
    { 'X-Forwarded-Host': 'bad.example/path', 'X-Forwarded-Proto': 'javascript' },
    {},
  ])('ignores client-supplied forwarded headers without configured public origins: %j', headers => {
    vi.stubEnv('HOST_PUBLIC_URL', '')
    expect(resolvePublicAppBaseUrl(new Request('http://localhost:3000/api/setup', { headers }))).toBe('http://localhost:3000')
  })
  it('supports a direct local request without proxy headers', () => {
    vi.stubEnv('HOST_PUBLIC_URL', '')
    expect(resolvePublicAppBaseUrl('http://localhost:3000/path')).toBe('http://localhost:3000')
  })
})
