/**
 * TabtenderProvider against a fake Tab Tender server that answers as its API
 * reference (docs/api.md) describes:
 * - a TTL over `sessions.maxTTL` is refused (400 validation_error) with the cap in the message;
 * - a named profile is locked while a session holds it (409 profile_in_use);
 * - an ended session reads `terminated` for ten minutes, then 404;
 * - deleting an ended session answers 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  watch: vi.fn(),
  stopWatch: vi.fn(),
  settings: { apiKeys: { tabtenderUrl: 'https://tt.example.com', tabtenderApiKey: 'tt_key' } as Record<string, string | undefined> },
}))
vi.mock('./google-passkey-recovery', () => ({
  GooglePasskeyRecovery: class { watch = h.watch; stop = h.stopWatch },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => h.settings,
  effectiveTabtenderUrlFrom: (settings: typeof h.settings) => settings.apiKeys?.tabtenderUrl,
  effectiveTabtenderApiKeyFrom: (settings: typeof h.settings) => settings.apiKeys?.tabtenderApiKey,
}))

import { TabtenderProvider, tabtenderProfileName, maxTtlFrom, TABTENDER_SESSION_TTL_SECONDS } from './tabtender-provider'

interface FakeSession { id: string; status: string; profile?: string; ttlSeconds?: number; token: string }

class FakeTabtender {
  maxTtl = 14_400
  sessions = new Map<string, FakeSession>()
  creates: Array<Record<string, unknown>> = []
  deletes: string[] = []
  authHeaders: string[] = []
  /** Session reads answered 503 (the server briefly unreachable). */
  failingReads = 0
  private next = 0

  start(profile?: string): FakeSession {
    const n = ++this.next
    const session: FakeSession = { id: `sess_${n}`, status: 'running', profile, token: `tok${n}`.padEnd(43, 'x') }
    this.sessions.set(session.id, session)
    return session
  }

  /** As Tab Tender answers: the token only inside cdpUrl, which is gone once terminated. */
  private view({ token, ...session }: FakeSession) {
    return {
      ...session,
      ...(session.status !== 'terminated' && { cdpUrl: `wss://tunnel.example.net/v1/sessions/${session.id}/cdp?token=${token}` }),
    }
  }

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    this.authHeaders.push((init?.headers as Record<string, string>)?.Authorization ?? '')
    const err = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })
    const one = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/)

    if (method === 'POST' && url.pathname === '/v1/sessions') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { ttlSeconds?: number; profile?: string }
      this.creates.push(body)
      if (body.ttlSeconds && body.ttlSeconds > this.maxTtl) {
        return err(400, 'validation_error', `ttlSeconds ${body.ttlSeconds} exceeds the maximum session TTL of ${this.maxTtl} seconds`)
      }
      if (body.profile && [...this.sessions.values()].some((s) => s.profile === body.profile && s.status === 'running')) {
        return err(409, 'profile_in_use', `profile ${body.profile} is in use by another session`)
      }
      const session = this.start(body.profile)
      session.ttlSeconds = body.ttlSeconds
      return Response.json(this.view(session), { status: 201 })
    }
    if (method === 'GET' && url.pathname === '/v1/sessions') {
      return Response.json({ sessions: [...this.sessions.values()].filter((s) => s.status === 'running').map((s) => this.view(s)) })
    }
    if (one && method === 'GET') {
      if (this.failingReads > 0) {
        this.failingReads--
        return new Response('upstream unavailable', { status: 503 })
      }
      const session = this.sessions.get(one[1])
      return session ? Response.json(this.view(session)) : err(404, 'session_not_found', 'no such session')
    }
    if (one && method === 'DELETE') {
      this.deletes.push(one[1])
      const session = this.sessions.get(one[1])
      if (!session || session.status === 'terminated') return err(404, 'session_not_found', 'no such session')
      session.status = 'terminated'
      return Response.json(this.view(session))
    }
    return err(404, 'not_found', 'no such endpoint')
  }
}

const urlOf = (id: string) => `wss://tunnel.example.net/v1/sessions/${id}/cdp?token=${server.sessions.get(id)!.token}`

let server: FakeTabtender
let provider: TabtenderProvider

beforeEach(() => {
  server = new FakeTabtender()
  vi.stubGlobal('fetch', vi.fn(server.handle))
  provider = new TabtenderProvider()
  h.settings = { apiKeys: { tabtenderUrl: 'https://tt.example.com', tabtenderApiKey: 'tt_key' } }
  h.watch.mockClear()
  h.stopWatch.mockClear()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('tabtenderProfileName', () => {
  it('names the profile after the agent', () => {
    expect(tabtenderProfileName('k3j9x0a2bq')).toBe('superagent-k3j9x0a2bq')
  })

  it('digests an id that is no valid profile name', () => {
    const name = tabtenderProfileName('weird id/with:chars')
    expect(name).toMatch(/^superagent-[0-9a-f]{32}$/)
    expect(tabtenderProfileName('weird id/with:chars')).toBe(name)
    expect(tabtenderProfileName('x'.repeat(80))).toMatch(/^superagent-[0-9a-f]{32}$/)
  })
})

describe('maxTtlFrom', () => {
  it('reads the cap from a refused TTL', () => {
    expect(maxTtlFrom('ttlSeconds 21600 exceeds the maximum session TTL of 14400 seconds')).toBe(14_400)
    expect(maxTtlFrom('something else')).toBeNull()
  })
})

describe('TabtenderProvider', () => {
  it('is unavailable until both a URL and a key are configured', async () => {
    h.settings = { apiKeys: { tabtenderApiKey: 'tt_key' } }
    expect(await provider.detect()).toMatchObject({ available: false, reason: 'Server URL not configured' })
    h.settings = { apiKeys: { tabtenderUrl: 'https://tt.example.com' } }
    expect(await provider.detect()).toMatchObject({ available: false, reason: 'API key not configured' })
    h.settings = { apiKeys: { tabtenderUrl: 'https://tt.example.com', tabtenderApiKey: 'tt_key' } }
    expect(await provider.detect()).toMatchObject({ id: 'tabtender', available: true })
  })

  it('opens a session on the agent profile and hands the container its token URL, never the key', async () => {
    const info = await provider.launch('agent1', {}, 'agent1')
    expect(info).toEqual({ cdpUrl: urlOf('sess_1') })
    expect(JSON.stringify(info)).not.toContain('tt_key')
    // Refused over the server's default 4-hour cap, then created at it.
    expect(server.creates).toEqual([
      { profile: 'superagent-agent1', ttlSeconds: TABTENDER_SESSION_TTL_SECONDS },
      { profile: 'superagent-agent1', ttlSeconds: 14_400 },
    ])
    expect(server.authHeaders.every((v) => v === 'Bearer tt_key')).toBe(true)
    expect(h.watch).toHaveBeenLastCalledWith('agent1', urlOf('sess_1'))
    expect(provider.isRunning('agent1')).toBe(true)
  })

  it('asks for its TTL first and takes the server cap when refused', async () => {
    server.maxTtl = 100_000
    await provider.launch('agent1', {}, 'agent1')
    expect(server.creates).toEqual([{ profile: 'superagent-agent1', ttlSeconds: TABTENDER_SESSION_TTL_SECONDS }])
  })

  it('hands back the same URL while the session runs', async () => {
    const first = await provider.launch('agent1', {}, 'agent1')
    const again = await provider.launch('agent1', {}, 'agent1')
    expect(again.cdpUrl).toBe(first.cdpUrl)
    expect(server.sessions.size).toBe(1)
  })

  it('keeps the session when the server does not answer', async () => {
    const first = await provider.launch('agent1', {}, 'agent1')
    server.failingReads = 1
    expect((await provider.launch('agent1', {}, 'agent1')).cdpUrl).toBe(first.cdpUrl)
    expect(server.sessions.size).toBe(1)
  })

  it('joins concurrent opens into one session', async () => {
    const [a, b] = await Promise.all([provider.launch('agent1', {}, 'agent1'), provider.launch('agent1', {}, 'agent1')])
    expect(a.cdpUrl).toBe(b.cdpUrl)
    expect(server.sessions.size).toBe(1)
  })

  it('opens a new session once the old one ended', async () => {
    await provider.launch('agent1', {}, 'agent1')
    server.sessions.get('sess_1')!.status = 'terminated' // TTL reached
    const second = await provider.launch('agent1', {}, 'agent1')
    expect(second.cdpUrl).toBe(urlOf('sess_2'))
    expect(server.creates.at(-1)).toMatchObject({ profile: 'superagent-agent1' })
  })

  it('treats a session the server no longer knows (it restarted) as ended', async () => {
    await provider.launch('agent1', {}, 'agent1')
    server.sessions.clear()
    const info = await provider.launch('agent1', {}, 'agent1')
    expect(info.cdpUrl).toBe(urlOf('sess_2'))
    expect(server.sessions.size).toBe(1)
  })

  it('uses the live session holding the agent profile after an app restart, instead of failing', async () => {
    const before = server.start('superagent-agent1')
    const info = await provider.launch('agent1', {}, 'agent1')
    expect(info.cdpUrl).toBe(urlOf(before.id))
    expect(server.sessions.size).toBe(1)
  })

  it('stops a session: ends it on the server', async () => {
    await provider.launch('agent1', {}, 'agent1')
    await provider.stop('agent1')
    expect(server.deletes).toEqual(['sess_1'])
    expect(provider.isRunning('agent1')).toBe(false)
    expect(h.stopWatch).toHaveBeenCalledWith('agent1')
  })

  it('stops the live session on the agent profile that this process did not open', async () => {
    const before = server.start('superagent-agent1')
    server.start('superagent-agent2')
    await provider.stop('agent1')
    expect(server.deletes).toEqual([before.id])
  })

  it('a stop waits for a launch under way, then ends what it opened', async () => {
    const launch = provider.launch('agent1', {}, 'agent1')
    await provider.stop('agent1')
    await launch
    expect(server.deletes).toEqual(['sess_1'])
    expect(provider.isRunning('agent1')).toBe(false)
  })

  it('stops every session at shutdown', async () => {
    await provider.launch('agent1', {}, 'agent1')
    await provider.launch('agent2', {}, 'agent2')
    await provider.stopAll()
    expect(server.deletes.sort()).toEqual(['sess_1', 'sess_2'])
    expect(provider.isRunning()).toBe(false)
  })

  it('refuses to launch without credentials', async () => {
    h.settings = { apiKeys: {} }
    await expect(provider.launch('agent1', {}, 'agent1')).rejects.toThrow('must be configured')
  })

  it('passes on any other refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'capacity_exceeded', message: 'limit of 8 reached' } }, { status: 429 })))
    await expect(provider.launch('agent1', {}, 'agent1')).rejects.toThrow('capacity_exceeded')
  })
})
