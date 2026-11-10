import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The agent's container as the host reaches it: the browser it reports, and what each capture finds. */
const container = vi.hoisted(() => ({
  browser: { active: true, sessionId: 's-1', location: 'container', generation: 1 } as Record<string, unknown>,
  /** The user-input requests open on the agent: a hand-over or a sign-in card has the browser. */
  open: [] as Array<{ id: string; kind: string; scope: { sessionId: string } }>,
  /** The site's state as each capture finds it, in order; the last one repeats. A string is its fingerprint. */
  states: [] as Array<string | { status: number }>,
  /** How /browser/session/restore answers. */
  restore: { status: 200, body: { restored: true, skippedRecords: 0 } as Record<string, unknown> },
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
            const state = container.states.length > 1 ? container.states.shift()! : container.states[0]
            if (typeof state !== 'string') return new Response('{}', { status: state.status })
            const same = body.peek || body.unlessHash === state
            return new Response(JSON.stringify({ hash: state, ...(same ? {} : { bundle: bundleOf(state) }) }), { status: 200 })
          }
          return new Response('{}', { status: 404 })
        },
      },
      inputs: {
        snapshot: async (sessionId: string) => container.open.filter((request) => request.scope.sessionId === sessionId),
      },
    }),
  },
}))

const bundleOf = (who: string) => ({
  version: 1,
  site: 'github.com',
  capturedAt: '2026-10-26T00:00:00.000Z',
  cookies: [{ name: 's', value: who, domain: 'github.com', path: '/', httpOnly: true, secure: true }],
  origins: [],
})

const saved = vi.hoisted(() => [] as Array<{ agentSlug: string; accountId: string; browserType: string; who: string }>)
vi.mock('./session-service', () => ({
  saveAccountSession: vi.fn(async (input: { agentSlug: string; account: { id: string }; browserType: string; bundle: { cookies: Array<{ value: string }> } }) => {
    saved.push({ agentSlug: input.agentSlug, accountId: input.account.id, browserType: input.browserType, who: input.bundle.cookies[0]?.value })
  }),
  heldSessionVersion: vi.fn(),
  markSessionHeld: vi.fn(),
  readAccountSession: vi.fn(),
}))
vi.mock('./vault-service', () => ({ recordAccountUse: vi.fn() }))

const sessions = await import('./session-service')
const vault = await import('./vault-service')
const {
  beginSignInStep,
  resetSessionWatches,
  restoreSavedSession,
  sessionBaseline,
  stopSessionWatches,
  watchAfterHandOver,
  watchSignIn,
} = await import('./session-host')

const ACCOUNT = {
  id: 'acc-1',
  site: 'github.com',
  origin: 'https://github.com',
  ownerId: null as string | null,
  via: null as { id: string; site: string; username: string; label: null } | null,
}
const SCOPE = { site: 'github.com', origin: 'https://github.com' }
const captureCalls = () => container.calls.filter((call) => call.path === '/browser/session/capture')
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** A step for `account` goes in on its site, whose state reads `before` first: the other sign-ins end, then it is watched. */
async function step(account: typeof ACCOUNT, before: string, agentSlug = 'agent-a') {
  container.states = [before]
  beginSignInStep(agentSlug, { site: account.site, username: null, accountId: account.id })
  const baseline = await sessionBaseline({ agentSlug, sessionId: 's-1', scope: { site: account.site, origin: account.origin } })
  watchSignIn({ agentSlug, sessionId: 's-1', account, baseline })
  return baseline
}

beforeEach(() => {
  vi.useFakeTimers()
  container.browser = { active: true, sessionId: 's-1', location: 'container', generation: 1 }
  container.open = []
  container.states = ['signed-out']
  container.restore = { status: 200, body: { restored: true, skippedRecords: 0 } }
  container.calls = []
  saved.length = 0
  vi.mocked(sessions.readAccountSession).mockReset()
  vi.mocked(sessions.heldSessionVersion).mockReset()
  vi.mocked(sessions.markSessionHeld).mockReset()
  vi.mocked(vault.recordAccountUse).mockReset()
})

afterEach(() => {
  resetSessionWatches()
  vi.useRealTimers()
})

describe('the sign-in watch', () => {
  it('reads the site before the step, and saves nothing until it differs from that', async () => {
    const baseline = await step(ACCOUNT, 'signed-out')
    expect(baseline).toEqual({ browserType: 'container', generation: 1, scope: SCOPE, hash: 'signed-out' })
    expect(captureCalls()[0].body).toMatchObject({ peek: true, site: 'github.com', origin: 'https://github.com' })

    container.states = ['signed-out', 'signed-in']
    await advance(0)
    expect(captureCalls()).toHaveLength(1)
    // A first look right after the step: the page has not moved on yet.
    await advance(2_000)
    expect(captureCalls().at(-1)?.body).toMatchObject({ unlessHash: 'signed-out' })
    expect(saved).toEqual([])
    await advance(15_000)
    expect(saved).toEqual([{ agentSlug: 'agent-a', accountId: 'acc-1', browserType: 'container', who: 'signed-in' }])
    expect(captureCalls().at(-1)?.body).toMatchObject({ unlessHash: 'signed-out' })
    await advance(15_000)
    expect(captureCalls().at(-1)?.body).toMatchObject({ unlessHash: 'signed-in' })
    expect(saved).toHaveLength(1)
  })

  it('sees a sign-in the app keeps in its storage alone: any change to the state counts', async () => {
    // The fingerprint covers storage (the container's hashSession): a token stored is a new one.
    await step(ACCOUNT, 'no-token')
    container.states = ['token-stored']
    await advance(2_000)
    expect(saved.map((entry) => entry.who)).toEqual(['token-stored'])
  })

  it('saves a change at once when the site held still before it (a push approved), and a state it holds after changing', async () => {
    await step(ACCOUNT, 'password-step')
    container.states = ['waiting', 'waiting', 'approved', 'approved', 'r1', 'r2', 'r3', 'r3']
    await advance(2_000 + 7 * 15_000)
    // 2 s: waiting; 32 s: approved, after a look that saw no change; 62 s: r1, likewise;
    // 77 s and 92 s: changing on each look, held back; 107 s: r3 held still.
    expect(saved.map((entry) => entry.who)).toEqual(['waiting', 'approved', 'r1', 'r3'])
  })

  it('saves at most once a minute while the site keeps changing, and its last state when the watch ends', async () => {
    await step(ACCOUNT, 'v0')
    container.states = Array.from({ length: 20 }, (_, i) => `v${i + 1}`)
    await advance(3 * 60_000 + 5_000)
    // At 2 s, 62 s and 122 s, and once more as the watch ends (182 s).
    expect(saved.map((entry) => entry.who)).toEqual(['v1', 'v5', 'v9', 'v13'])
    const looks = captureCalls().length
    await advance(60_000)
    expect(captureCalls()).toHaveLength(looks)
  })

  it('stops when the browser closes or changes hands, or the session switches to another kind of browser', async () => {
    await step(ACCOUNT, 'signed-out')
    container.states = [{ status: 409 }]
    await advance(60_000)
    expect(captureCalls()).toHaveLength(2)
    // Nor does a hand-over finish it later: the browser it was in is gone.
    container.states = ['signed-in-in-another-browser']
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: null, site: 'github.com' })
    await advance(0)
    expect(captureCalls()).toHaveLength(2)

    await step(ACCOUNT, 'signed-out')
    container.calls = []
    container.browser = { active: true, sessionId: 's-1', location: 'host' }
    container.states = ['signed-in-elsewhere']
    await advance(60_000)
    expect(captureCalls()).toEqual([])
    expect(saved).toEqual([])
  })

  it('stops for a site the browser refuses, or a session bigger than one keeps', async () => {
    for (const status of [400, 413]) {
      await step(ACCOUNT, 'signed-out')
      container.calls = []
      container.states = [{ status }]
      await advance(60_000)
      expect(captureCalls()).toHaveLength(1)
    }
  })

  it('watches nothing when the site could not be read before the step, and ends the watch of a step before it', async () => {
    await step(ACCOUNT, 'signed-out')
    container.calls = []
    container.browser = { active: true, sessionId: 's-other', location: 'container' }
    expect(await sessionBaseline({ agentSlug: 'agent-a', sessionId: 's-1', scope: SCOPE })).toBeNull()
    watchSignIn({ agentSlug: 'agent-a', sessionId: 's-1', account: { ...ACCOUNT, id: 'acc-2' }, baseline: null })
    container.browser = { active: true, sessionId: 's-1', location: 'container' }
    container.states = ['signed-in']
    await advance(60_000)
    expect(captureCalls()).toEqual([])
    expect(saved).toEqual([])
  })

  it('gives way to a newer step on the site, which saves to its own account', async () => {
    await step(ACCOUNT, 'signed-out')
    await step({ ...ACCOUNT, id: 'acc-bob' }, 'signed-out')
    container.states = ['bob']
    await advance(15_000)
    expect(saved).toEqual([{ agentSlug: 'agent-a', accountId: 'acc-bob', browserType: 'container', who: 'bob' }])
  })

  it('saves nothing more once a step for another account, or for none, went in on the site', async () => {
    await step(ACCOUNT, 'signed-out')
    beginSignInStep('agent-a', { site: 'github.com', username: 'someone', accountId: null })
    container.states = ['someone-else']
    await advance(60_000)
    expect(saved).toEqual([])
    // Nor does a hand-over bring it back.
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: null, site: 'github.com' })
    await advance(0)
    expect(saved).toEqual([])
  })

  it('ends with a step on any other site, in any session of the agent: sites share cookies, and a sign-in lands elsewhere', async () => {
    await step({ ...ACCOUNT, id: 'acc-acme', site: 'acme.slack.com', origin: 'https://acme.slack.com' }, 'signed-out')
    await step({ ...ACCOUNT, id: 'acc-other', site: 'other.example', origin: 'https://other.example' }, 'signed-out', 'agent-b')
    // A step on beta.slack.com rewrites the .slack.com cookies acme.slack.com's watch reads.
    beginSignInStep('agent-a', { site: 'beta.slack.com', username: 'bob', accountId: 'acc-bob' })
    container.calls = []
    container.states = ['bob']
    await advance(60_000)
    expect([...new Set(captureCalls().map((call) => call.agent))]).toEqual(['agent-b'])
    expect(saved.map((entry) => entry.accountId)).toEqual(['acc-other'])
  })

  it('goes on through the provider step of a sign-in with another account (via), and only that one', async () => {
    const GOOGLE = { id: 'acc-google', site: 'accounts.google.com', username: 'me@gmail.com', label: null }
    const app = { ...ACCOUNT, id: 'acc-app', site: 'app.example', origin: 'https://app.example', via: GOOGLE }
    await step(app, 'signed-out')
    beginSignInStep('agent-a', { site: 'accounts.google.com', username: null, accountId: 'acc-google' })
    beginSignInStep('agent-a', { site: 'accounts.google.com', username: ' Me@Gmail.com', accountId: null })
    container.states = ['signed-in-through-google']
    await advance(2_000)
    expect(saved.map((entry) => entry.accountId)).toEqual(['acc-app'])

    // Another Google account signs the app in as someone else.
    await step(app, 'signed-out')
    beginSignInStep('agent-a', { site: 'accounts.google.com', username: 'someone@gmail.com', accountId: null })
    container.states = ['someone-else']
    await advance(60_000)
    expect(saved).toHaveLength(1)
  })

  it('stops when the browser was opened again since the step, and a hand-over does not bring it back', async () => {
    await step({ ...ACCOUNT, ownerId: 'u-1' }, 'signed-out')
    container.browser = { ...container.browser, generation: 2 }
    container.states = ['signed-out-after-relaunch']
    await advance(60_000)
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: 'github.com' })
    container.browser = { ...container.browser, generation: 1 }
    await advance(60_000)
    expect(saved).toEqual([])
  })

  it('does not look while the user has the browser: the owner\'s done looks at once, anyone else\'s ends the sign-in', async () => {
    await step({ ...ACCOUNT, ownerId: 'u-1' }, 'signed-out')
    container.open = [{ id: 'hand-over', kind: 'browser_input', scope: { sessionId: 's-1' } }]
    container.calls = []
    container.states = ['someone-signing-in']
    await advance(60_000)
    expect(captureCalls()).toEqual([])
    container.open = []
    container.states = ['owner-signed-in']
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: 'github.com' })
    await advance(0)
    expect(saved.map((entry) => entry.who)).toEqual(['owner-signed-in'])

    // A sign-in card open counts too; someone else done, or declining, ends it.
    for (const site of ['github.com', null]) {
      saved.length = 0
      await step({ ...ACCOUNT, ownerId: 'u-1' }, 'signed-out')
      container.open = [{ id: 'card', kind: 'login', scope: { sessionId: 's-1' } }]
      container.states = ['u-2-signed-in']
      await advance(30_000)
      container.open = []
      watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-2', site })
      await advance(3 * 60_000)
      expect(saved).toEqual([])
    }
  })

  it('goes on after the owner\'s hand-over or decline elsewhere, without looking for it', async () => {
    await step({ ...ACCOUNT, ownerId: 'u-1' }, 'signed-out')
    container.calls = []
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: 'captcha.example' })
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: null })
    await advance(0)
    expect(captureCalls()).toEqual([])
    container.states = ['signed-in']
    await advance(2_000)
    expect(saved.map((entry) => entry.who)).toEqual(['signed-in'])
  })

  it('after the owner\'s hand-over, looks again at once and saves what changed since', async () => {
    await step({ ...ACCOUNT, ownerId: 'u-1' }, 'signed-out')
    await advance(5 * 60_000)
    container.calls = []
    container.states = ['passkey-done']

    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: 'github.com' })
    await advance(0)
    expect(captureCalls()[0].body).toMatchObject({ unlessHash: 'signed-out' })
    expect(saved).toEqual([{ agentSlug: 'agent-a', accountId: 'acc-1', browserType: 'container', who: 'passkey-done' }])

    // A hand-over that changed nothing (a CAPTCHA) saves nothing.
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: 'github.com' })
    await advance(0)
    expect(saved).toHaveLength(1)
  })

  it('ends the sign-in when someone else finishes a hand-over: who they signed in as is not the account\'s', async () => {
    await step({ ...ACCOUNT, ownerId: 'u-1' }, 'signed-out')
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-2', site: 'github.com' })
    container.states = ['someone-else']
    await advance(60_000)
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: 'u-1', site: 'github.com' })
    await advance(60_000)
    expect(saved).toEqual([])
  })

  it('does not look again after a hand-over long after the sign-in, nor a later one for the hand-overs between', async () => {
    await step(ACCOUNT, 'signed-out')
    await advance(20 * 60_000)
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: null, site: 'github.com' })
    await advance(11 * 60_000)
    container.calls = []
    container.states = ['changed']
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-1', viewer: null, site: 'github.com' })
    watchAfterHandOver({ agentSlug: 'agent-a', sessionId: 's-2', viewer: null, site: 'github.com' })
    await advance(0)
    expect(captureCalls()).toEqual([])
  })

  it('stops for an account deleted or forgotten, or revoked from one agent', async () => {
    await step(ACCOUNT, 'signed-out', 'agent-a')
    await step(ACCOUNT, 'signed-out', 'agent-b')
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

describe('restoring a saved session', () => {
  const OCTOCAT = { ...ACCOUNT, username: 'octocat', label: null, parts: ['password'], via: null, rejectedAt: null, createdAt: new Date(0), updatedAt: new Date(0), lastUsedAt: null }
  const SAVED = { version: 7, capturedAt: new Date(0), bundle: { version: 1 as const, site: 'github.com', capturedAt: '2026-10-26T00:00:00.000Z', cookies: [], origins: [] } }
  const restoreCalls = () => container.calls.filter((call) => call.path === '/browser/session/restore')
  const restore = () => restoreSavedSession({ agentSlug: 'agent-a', sessionId: 's-1', account: OCTOCAT })

  beforeEach(() => {
    vi.mocked(sessions.heldSessionVersion).mockResolvedValue(3)
    vi.mocked(sessions.readAccountSession).mockResolvedValue(SAVED)
  })

  it('puts in a capture the browser does not hold, counts it as held, and does not watch what it put in', async () => {
    expect(await restore()).toEqual({ type: 'session', site: 'github.com', username: 'octocat', restored: true })
    expect(sessions.readAccountSession).toHaveBeenCalledWith(OCTOCAT, 'container', { unlessVersion: 3 })
    expect(restoreCalls()).toEqual([{ agent: 'agent-a', path: '/browser/session/restore', body: { sessionId: 's-1', site: 'github.com', origin: 'https://github.com', bundle: SAVED.bundle } }])
    expect(sessions.markSessionHeld).toHaveBeenCalledWith({ agentSlug: 'agent-a', account: OCTOCAT, version: 7 })
    expect(vault.recordAccountUse).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-1', password: false, by: 'vault', session: true }))
    container.states = ['refreshed-by-the-site']
    await advance(3 * 60_000)
    expect(captureCalls()).toEqual([])
  })

  it('ends the sign-ins being watched in the browser first, whatever comes of it', async () => {
    await step(ACCOUNT, 'signed-out')
    container.restore = { status: 500, body: { error: 'x', touched: true, changed: true, cleared: true } }
    await restore()
    container.states = ['emptied']
    await advance(60_000)
    expect(saved).toEqual([])

    // A sibling site's restore rewrites the parent domain's cookies another site's watch reads.
    await step({ ...ACCOUNT, id: 'acc-acme', site: 'acme.slack.com', origin: 'https://acme.slack.com' }, 'signed-out')
    container.restore = { status: 200, body: { restored: true, skippedRecords: 0 } }
    await restoreSavedSession({ agentSlug: 'agent-a', sessionId: 's-1', account: { ...OCTOCAT, site: 'beta.slack.com', origin: 'https://beta.slack.com' } })
    container.states = ['bob-on-slack']
    await advance(60_000)
    expect(saved).toEqual([])
  })

  it('leaves the page alone when the browser holds the capture, or the session holds no browser', async () => {
    vi.mocked(sessions.readAccountSession).mockResolvedValue(null)
    expect(await restore()).toBeNull()
    vi.mocked(sessions.readAccountSession).mockResolvedValue(SAVED)
    container.browser = { active: true, sessionId: 's-other', location: 'container' }
    expect(await restore()).toBeNull()
    expect(restoreCalls()).toEqual([])
  })

  it('reports what a failed restore left, counting one that moved the page as tried and one that did not as never tried', async () => {
    container.restore = { status: 500, body: { error: 'x', touched: true, changed: false, cleared: false } }
    expect(await restore()).toEqual({ type: 'session', site: 'github.com', username: 'octocat', restored: false, changed: false, cleared: false })
    expect(sessions.markSessionHeld).toHaveBeenCalledWith({ agentSlug: 'agent-a', account: OCTOCAT, version: 7 })
    vi.mocked(sessions.markSessionHeld).mockClear()
    container.restore = { status: 500, body: { error: 'x', touched: false, changed: false, cleared: false } }
    expect(await restore()).toBeNull()
    expect(sessions.markSessionHeld).not.toHaveBeenCalled()
  })

  it('for a pick in the card: grants the account once the page moved, before marking it held, as the user\'s use', async () => {
    const order: string[] = []
    const grant = vi.fn(async () => { order.push('grant') })
    vi.mocked(sessions.markSessionHeld).mockImplementation(async () => { order.push('mark') })
    const picked = { userId: 'u-1', grant }
    expect(await restoreSavedSession({ agentSlug: 'agent-a', sessionId: 's-1', account: OCTOCAT, picked })).toMatchObject({ restored: true })
    // The mark is on the grant: a mark before it would be lost, and the same capture would go in again.
    expect(order).toEqual(['grant', 'mark'])
    expect(vault.recordAccountUse).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1', password: false, by: 'user', session: true }))

    order.length = 0
    container.restore = { status: 500, body: { error: 'x', touched: true, changed: true, cleared: true } }
    expect(await restoreSavedSession({ agentSlug: 'agent-a', sessionId: 's-1', account: OCTOCAT, picked })).toMatchObject({ restored: false })
    expect(order).toEqual(['grant', 'mark'])

    // Nothing moved: nothing granted, and the fill decides.
    grant.mockClear()
    container.restore = { status: 500, body: { error: 'x', touched: false, changed: false, cleared: false } }
    expect(await restoreSavedSession({ agentSlug: 'agent-a', sessionId: 's-1', account: OCTOCAT, picked })).toBeNull()
    expect(grant).not.toHaveBeenCalled()
  })
})
