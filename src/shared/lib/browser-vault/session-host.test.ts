import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The agent's container as the host reaches it: the browser it reports, and what each capture finds. */
const container = vi.hoisted(() => ({
  browser: { active: true, sessionId: 's-1', location: 'container' } as Record<string, unknown>,
  /** Answers for /browser/session/capture, in order; the last one repeats. */
  captures: [] as Array<{ status: number; body: Record<string, unknown> }>,
  /** How /browser/session/restore answers. */
  restore: { status: 200, body: { restored: true, skippedRecords: 0, cookieHash: 'restored' } as Record<string, unknown> },
  calls: [] as Array<{ agent: string; path: string; body?: Record<string, unknown> }>,
}))

vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: (agent: string) => ({
      container: {
        fetch: async (url: string, init?: RequestInit) => {
          const body = init?.body ? JSON.parse(String(init.body)) : undefined
          container.calls.push({ agent, path: url, ...(body ? { body } : {}) })
          if (url === '/browser/status') return new Response(JSON.stringify(container.browser), { status: 200 })
          if (url === '/browser/session/restore') return new Response(JSON.stringify(container.restore.body), { status: container.restore.status })
          if (url === '/browser/session/capture') {
            const answer = container.captures.length > 1 ? container.captures.shift()! : container.captures[0]
            return new Response(JSON.stringify(answer.body), { status: answer.status })
          }
          return new Response('{}', { status: 404 })
        },
      },
    }),
  },
}))

const saved = vi.hoisted(() => [] as Array<{ agentSlug: string; accountId: string; who: string }>)
vi.mock('./session-service', () => ({
  saveAccountSession: vi.fn(async (input: { agentSlug: string; account: { id: string }; bundle: { cookies: Array<{ value: string }> } }) => {
    saved.push({ agentSlug: input.agentSlug, accountId: input.account.id, who: input.bundle.cookies[0]?.value })
  }),
  heldSessionVersion: vi.fn(),
  heldAccountOnSite: vi.fn(),
  markSessionHeld: vi.fn(),
  readAccountSession: vi.fn(),
}))
vi.mock('./vault-service', () => ({ recordAccountUse: vi.fn(), getAccount: vi.fn() }))

const sessions = await import('./session-service')
const vault = await import('./vault-service')
const { resetSessionWatches, stopSessionWatches, syncSessionOnOpen, watchAfterHandOver, watchSignIn } = await import('./session-host')

const ACCOUNT = { id: 'acc-1', site: 'github.com', origin: 'https://github.com', ownerId: null }

const captured = (who: string, cookieHash = who) => ({
  status: 200,
  body: {
    unchanged: false,
    cookieHash,
    bundle: { version: 1, site: 'github.com', capturedAt: '2026-10-26T00:00:00.000Z', cookies: [{ name: 's', value: who, domain: 'github.com', path: '/', httpOnly: true, secure: true }], origins: [] },
  },
})
const unchanged = (cookieHash: string) => ({ status: 200, body: { unchanged: true, cookieHash } })
const captureCalls = () => container.calls.filter((call) => call.path === '/browser/session/capture')

/** Let the watch's timers fire up to `ms` from now, with their work done. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  container.browser = { active: true, sessionId: 's-1', location: 'container' }
  container.captures = [unchanged('none')]
  container.restore = { status: 200, body: { restored: true, skippedRecords: 0, cookieHash: 'restored' } }
  container.calls = []
  saved.length = 0
  vi.mocked(sessions.heldAccountOnSite).mockReset()
  vi.mocked(sessions.readAccountSession).mockReset()
  vi.mocked(sessions.markSessionHeld).mockReset()
  vi.mocked(vault.getAccount).mockReset()
  vi.mocked(vault.recordAccountUse).mockReset()
})

afterEach(() => {
  resetSessionWatches()
  vi.useRealTimers()
})

describe('the sign-in watch', () => {
  it('saves the site\'s session at once, then each time its cookies change, for three minutes', async () => {
    container.captures = [captured('password-step', 'h1'), unchanged('h1'), captured('approved', 'h2'), unchanged('h2')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })

    await advance(0)
    expect(saved).toEqual([{ agentSlug: 'agent-a', accountId: 'acc-1', who: 'password-step' }])
    await advance(15_000)
    expect(saved).toHaveLength(1)
    expect(captureCalls().at(-1)?.body).toMatchObject({ unlessCookieHash: 'h1' })
    await advance(15_000)
    expect(saved.map((entry) => entry.who)).toEqual(['password-step', 'approved'])

    await advance(3 * 60_000)
    const looks = captureCalls().length
    await advance(60_000)
    expect(captureCalls()).toHaveLength(looks)
    expect(captureCalls().length).toBeLessThanOrEqual(13)
  })

  it('stops when the browser closes, or another session holds it', async () => {
    container.captures = [captured('first', 'h1'), { status: 409, body: { error: 'no browser is open' } }]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })
    await advance(60_000)
    expect(captureCalls()).toHaveLength(2)

    container.calls = []
    container.browser = { active: true, sessionId: 's-other', location: 'container' }
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })
    await advance(60_000)
    expect(captureCalls()).toEqual([])
  })

  it('gives way to a newer step on the site, which saves to its own account', async () => {
    container.captures = [unchanged('h')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })
    await advance(0)
    container.captures = [captured('bob')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: { ...ACCOUNT, id: 'acc-bob' } })
    await advance(0)
    expect(saved).toEqual([{ agentSlug: 'agent-a', accountId: 'acc-bob', who: 'bob' }])
  })

  it('after a restore, saves only what the site changed, after a poll', async () => {
    container.captures = [unchanged('restored')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT, browserType: 'container', cookieHash: 'restored' })
    await advance(0)
    expect(captureCalls()).toEqual([])
    await advance(15_000)
    expect(captureCalls()[0].body).toMatchObject({ unlessCookieHash: 'restored' })
    expect(saved).toEqual([])
  })

  it('saves no more than five captures for a site that changes its cookies on every look', async () => {
    container.captures = Array.from({ length: 20 }, (_, i) => captured(`v${i}`, `h${i}`))
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })
    await advance(3 * 60_000)
    expect(saved).toHaveLength(5)
  })

  it('watches again after a hand-over, for the owner of the account the session last signed in with', async () => {
    container.captures = [unchanged('h')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: { ...ACCOUNT, ownerId: 'u-1' } })
    await advance(5 * 60_000)
    container.calls = []
    container.captures = [captured('passkey-done')]

    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-2' })
    await advance(0)
    expect(saved).toEqual([])

    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1' })
    await advance(0)
    expect(saved).toEqual([{ agentSlug: 'agent-a', accountId: 'acc-1', who: 'passkey-done' }])
  })

  it('does not watch after a hand-over long after the sign-in, or in another session', async () => {
    container.captures = [unchanged('h')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })
    await advance(31 * 60_000)
    container.calls = []
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: null })
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-2', viewer: null })
    await advance(0)
    expect(captureCalls()).toEqual([])
  })

  it('stops for an account deleted or forgotten, or revoked from one agent', async () => {
    container.captures = [unchanged('h')]
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: ACCOUNT })
    watchSignIn({ agentSlug: 'agent-b', sessionId: 's-1', account: ACCOUNT })
    await advance(0)
    container.calls = []
    stopSessionWatches('acc-1', 'agent-a')
    await advance(15_000)
    expect(captureCalls().map((call) => call.agent)).toEqual(['agent-b'])
    stopSessionWatches('acc-1')
    container.calls = []
    await advance(60_000)
    expect(captureCalls()).toEqual([])
  })
})

describe('syncing a newer session when the agent opens a page', () => {
  const OCTOCAT = { ...ACCOUNT, username: 'octocat', label: null, parts: ['password'], via: null, rejectedAt: null, createdAt: new Date(0), updatedAt: new Date(0), lastUsedAt: null }
  const SAVED = (version: number) => ({ version, capturedAt: new Date(0), bundle: { version: 1 as const, site: 'github.com', capturedAt: '2026-10-26T00:00:00.000Z', cookies: [], origins: [] } })
  const restoreCalls = () => container.calls.filter((call) => call.path === '/browser/session/restore')

  beforeEach(() => {
    vi.mocked(sessions.heldAccountOnSite).mockResolvedValue({ accountId: 'acc-1', version: 3 })
    vi.mocked(vault.getAccount).mockResolvedValue(OCTOCAT)
    vi.mocked(sessions.readAccountSession).mockResolvedValue(SAVED(7))
  })

  it('puts in a later capture of the account the browser holds on the site, and counts it as held', async () => {
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/settings?tab=1' })).toBe(true)
    expect(sessions.heldAccountOnSite).toHaveBeenCalledWith('agent-a', 'github.com')
    expect(restoreCalls()).toEqual([{ agent: 'agent-a', path: '/browser/session/restore', body: { sessionId: 's-1', site: 'github.com', origin: 'https://github.com', bundle: SAVED(7).bundle } }])
    expect(sessions.markSessionHeld).toHaveBeenCalledWith({ agentSlug: 'agent-a', account: OCTOCAT, version: 7 })
    expect(vault.recordAccountUse).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-1', password: false, by: 'vault', session: true }))
  })

  it('leaves the page alone when the browser holds that capture or a later one, or no account on the site', async () => {
    vi.mocked(sessions.readAccountSession).mockResolvedValue(SAVED(3))
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })).toBe(false)
    vi.mocked(sessions.readAccountSession).mockResolvedValue(null)
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })).toBe(false)
    vi.mocked(sessions.heldAccountOnSite).mockResolvedValue(null)
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })).toBe(false)
    expect(restoreCalls()).toEqual([])
  })

  it('looks only at the site of the page, as accounts are kept, and nothing that is not on the web', async () => {
    await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://www.github.com/' })
    expect(sessions.heldAccountOnSite).toHaveBeenLastCalledWith('agent-a', 'github.com')
    vi.mocked(sessions.heldAccountOnSite).mockClear()
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'chrome-error://chromewebdata/' })).toBe(false)
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'not a url' })).toBe(false)
    expect(sessions.heldAccountOnSite).not.toHaveBeenCalled()
  })

  it('puts nothing into a browser another session holds', async () => {
    container.browser = { active: true, sessionId: 's-other', location: 'container' }
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })).toBe(false)
    expect(restoreCalls()).toEqual([])
  })

  it('counts a restore that failed after it changed the page as tried, and one that failed before as not', async () => {
    container.restore = { status: 500, body: { error: 'x', touched: true, cleared: true } }
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })).toBe(false)
    expect(sessions.markSessionHeld).toHaveBeenCalledWith({ agentSlug: 'agent-a', account: OCTOCAT, version: 7 })
    vi.mocked(sessions.markSessionHeld).mockClear()
    container.restore = { status: 500, body: { error: 'x', touched: false, cleared: false } }
    expect(await syncSessionOnOpen({ agentSlug: 'agent-a', sessionId: 's-1', url: 'https://github.com/' })).toBe(false)
    expect(sessions.markSessionHeld).not.toHaveBeenCalled()
  })
})
