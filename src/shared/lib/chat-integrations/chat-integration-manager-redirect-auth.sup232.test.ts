/**
 * SUP-232 — Slack file download leaks bot token across cross-origin redirects.
 *
 * `downloadWithAuth` manually follows 3xx redirects and re-sends the Slack
 * `Authorization: Bearer <botToken>` header to every redirect target with no
 * origin/host check, so a redirect to an attacker host leaks the xoxb token.
 *
 * These tests stub global.fetch with a per-call recorder and drive the private
 * `downloadWithAuth`. The cross-origin hop must NOT carry the Authorization
 * header; a same-host Slack hop MUST keep it so legit downloads still auth.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatIntegrationManager } from './chat-integration-manager'

const DOWNLOAD_URL = 'https://files.slack.com/files-pri/T123-F456/secret.pdf'
const TOKEN = 'xoxb-secret-token'

interface FetchCall {
  url: string
  headers: Record<string, string> | undefined
}

function headerObj(init: unknown): Record<string, string> | undefined {
  const h = (init as { headers?: unknown } | undefined)?.headers
  if (!h) return undefined
  if (h instanceof Headers) {
    const o: Record<string, string> = {}
    h.forEach((v, k) => { o[k] = v })
    return o
  }
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][])
  return { ...(h as Record<string, string>) }
}

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
}

function authHeaderValue(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')
  return entry?.[1]
}

function fakeResponse(opts: { status: number; location?: string; body?: Buffer }): Response {
  const headers = new Map<string, string>()
  if (opts.location) headers.set('location', opts.location)
  const body = opts.body ?? Buffer.alloc(0)
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response
}

function installFetch(responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = []
  const queue = [...responses]
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
    calls.push({ url: String(input), headers: headerObj(init) })
    const next = queue.shift()
    if (!next) throw new Error(`Unexpected extra fetch to ${String(input)}`)
    return next
  }))
  return calls
}

describe('SUP-232 downloadWithAuth redirect token handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not forward Slack bearer tokens across cross-origin file redirects', async () => {
    const calls = installFetch([
      fakeResponse({ status: 302, location: 'https://attacker.example.test/slack-file' }),
      fakeResponse({ status: 200, body: Buffer.from('file-bytes') }),
    ])

    const buf = await (chatIntegrationManager as any).downloadWithAuth(DOWNLOAD_URL, TOKEN)
    expect(buf).not.toBeNull()

    const attackerCall = calls.find((c) => {
      try { return new URL(c.url).host === 'attacker.example.test' } catch { return false }
    })
    expect(attackerCall, 'expected a fetch to the attacker host').toBeDefined()
    expect(hasAuthHeader(attackerCall!.headers)).toBe(false)
  })

  it('keeps the Authorization header for same-host Slack redirects', async () => {
    const calls = installFetch([
      fakeResponse({ status: 302, location: 'https://files.slack.com/redirected/secret.pdf' }),
      fakeResponse({ status: 200, body: Buffer.from('file-bytes') }),
    ])

    const buf = await (chatIntegrationManager as any).downloadWithAuth(DOWNLOAD_URL, TOKEN)
    expect(buf).not.toBeNull()

    // First hop (the original Slack download URL) is authenticated.
    expect(authHeaderValue(calls[0].headers)).toBe(`Bearer ${TOKEN}`)
    // Second hop stays on a trusted Slack host, so auth is preserved.
    const redirectedCall = calls.find((c) => c.url.includes('/redirected/'))
    expect(redirectedCall, 'expected the same-host redirect hop').toBeDefined()
    expect(authHeaderValue(redirectedCall!.headers)).toBe(`Bearer ${TOKEN}`)
  })
})
