import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Bolt App initialization — the connector must never let a bad bot token reach
// the process-level unhandled-rejection handler.
//
// Bolt's App constructor calls singleAuthorization(), which fires auth.test on
// the bot token IMMEDIATELY and parks the promise in a closure that nothing
// awaits until the first inbound event. A revoked token rejects it with no
// handler attached, so it escapes every try/catch in connect() and reaches
// src/main/index.ts's unhandledRejection handler — which quits the whole app.
// One integration with a stale token therefore killed the desktop app.
//
// `deferInitialization: true` + an explicit `await app.init()` routes that same
// auth.test through a promise we own.
//
// The crash vector lives in the STUB, not in the production bug: the fake App
// parks a rejecting promise whenever deferInitialization is not set. The test
// therefore keeps failing if the fix is reverted OR reimplemented some other
// way that still leaves the constructor firing its own verification. The stub
// also mirrors Bolt's real start() guard (throws unless initialized), so the
// ordering requirement is proven rather than assumed.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  apps: [] as Array<{ opts: Record<string, unknown> }>,
  receivers: [] as Array<{ opts: Record<string, unknown>; client: unknown }>,
  /** null = auth.test succeeds; otherwise the Slack error code to fail with. */
  authFailure: null as string | null,
  /** Lifecycle call order, to prove init() precedes start(). */
  calls: [] as string[],
  /** When true, init() parks until the pushed deferred settles — lets a
   *  disconnect() race the new await point that the fix introduces. */
  deferInit: false,
  pendingInits: [] as Array<{ resolve: () => void }>,
}))

vi.mock('@slack/bolt', async () => {
  const { EventEmitter } = await import('node:events')

  function slackAuthError(code: string): Error {
    const err = new Error(`An API error occurred: ${code}`) as Error & {
      code: string
      data: { ok: false; error: string }
    }
    err.code = 'slack_webapi_platform_error'
    err.data = { ok: false, error: code }
    return err
  }

  class FakeClient extends EventEmitter {
    start = vi.fn(async () => { this.emit('connected') })
    disconnect = vi.fn(async () => { this.emit('disconnected') })
  }

  class SocketModeReceiver {
    opts: Record<string, unknown>
    client = new FakeClient()
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      hoisted.receivers.push(this)
    }
    init(): void {}
    async start(): Promise<void> { await this.client.start() }
    async stop(): Promise<void> { await this.client.disconnect() }
  }

  class App {
    opts: Record<string, unknown>
    receiver: SocketModeReceiver
    initialized: boolean
    client = {
      auth: {
        test: vi.fn(async () => {
          hoisted.calls.push('auth.test')
          if (hoisted.authFailure) throw slackAuthError(hoisted.authFailure)
          return { ok: true, user_id: 'U-bot', user: 'bot', team: 'T-test' }
        }),
      },
    }

    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.receiver = opts.receiver as SocketModeReceiver
      hoisted.apps.push(this)
      this.initialized = !opts.deferInitialization
      if (!opts.deferInitialization) {
        hoisted.calls.push('constructor-auth')
        // Real Bolt parks this promise; nothing attaches a handler to it here.
        if (hoisted.authFailure) void Promise.reject(slackAuthError(hoisted.authFailure))
      }
    }

    async init(): Promise<void> {
      hoisted.calls.push('init')
      if (hoisted.deferInit) {
        await new Promise<void>((resolve) => { hoisted.pendingInits.push({ resolve }) })
      }
      if (hoisted.authFailure) {
        this.initialized = false
        throw slackAuthError(hoisted.authFailure)
      }
      this.initialized = true
    }

    event(): void {}
    message(): void {}
    action(): void {}

    async start(): Promise<void> {
      // Mirrors Bolt's real guard (App.js:295).
      if (!this.initialized) {
        throw new Error('This App instance is not yet initialized. Call `await App#init()` before starting the app.')
      }
      hoisted.calls.push('start')
      await this.receiver.client.start()
    }
    async stop(): Promise<void> { await this.receiver.client.disconnect() }
  }

  return { App, SocketModeReceiver }
})

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import { SlackConnector } from './slack-connector'

function makeConnector(): SlackConnector {
  return new SlackConnector({ botToken: 'xoxb-test', appToken: 'xapp-test' })
}

/** Run fn and collect anything that reaches process-level unhandledRejection. */
async function captureUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
  const leaked: unknown[] = []
  const onUnhandled = (reason: unknown) => leaked.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await fn()
    // Let anything parked in a closure settle unobserved.
    await new Promise((r) => setTimeout(r, 250))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return leaked
}

beforeEach(() => {
  hoisted.apps.length = 0
  hoisted.receivers.length = 0
  hoisted.calls.length = 0
  hoisted.authFailure = null
  hoisted.deferInit = false
  hoisted.pendingInits.length = 0
})

afterEach(() => { vi.clearAllMocks() })

describe('Bolt App initialization is deferred and owned by connect()', () => {
  it('sets deferInitialization on the App, so it fires no unowned auth.test', async () => {
    const connector = makeConnector()
    await connector.connect()

    expect(hoisted.apps).toHaveLength(1)
    // Must be on the App. Putting it on the SocketModeReceiver is a silent
    // no-op that still typechecks — exactly how a careless conflict
    // resolution loses this fix.
    expect(hoisted.apps[0].opts.deferInitialization).toBe(true)
    expect(hoisted.receivers[0].opts.deferInitialization).toBeUndefined()
    expect(hoisted.calls).not.toContain('constructor-auth')

    await connector.disconnect()
  })

  it('awaits init() before start(), which Bolt rejects on an uninitialized app', async () => {
    const connector = makeConnector()
    await connector.connect()

    expect(hoisted.calls).toContain('init')
    expect(hoisted.calls).toContain('start')
    expect(hoisted.calls.indexOf('init')).toBeLessThan(hoisted.calls.indexOf('start'))

    await connector.disconnect()
  })

  it('a revoked bot token rejects connect() instead of crashing the app', async () => {
    hoisted.authFailure = 'invalid_auth'
    const connector = makeConnector()

    let rejection: unknown
    const leaked = await captureUnhandled(async () => {
      rejection = await connector.connect().catch((e: unknown) => e)
    })

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toMatch(/invalid_auth/)
    // Anything here becomes app.quit() in the main process.
    expect(leaked).toEqual([])
  })

  it('reports a revoked bot token as a token problem, not a vague init failure', async () => {
    hoisted.authFailure = 'invalid_auth'
    const connector = makeConnector()

    await expect(connector.connect()).rejects.toThrow(/Slack bot token invalid/)
  })

  it('leaves no socket behind when the token is bad', async () => {
    hoisted.authFailure = 'invalid_auth'
    const connector = makeConnector()

    await captureUnhandled(async () => { await connector.connect().catch(() => {}) })

    expect(connector.isConnected()).toBe(false)
    expect(hoisted.calls).not.toContain('start')
  })

  it('does not leak on any of the unrecoverable auth codes', async () => {
    for (const code of ['not_authed', 'account_inactive', 'token_revoked', 'team_disabled']) {
      hoisted.apps.length = 0
      hoisted.receivers.length = 0
      hoisted.calls.length = 0
      hoisted.authFailure = code
      const connector = makeConnector()

      const leaked = await captureUnhandled(async () => {
        await connector.connect().catch(() => {})
      })

      expect(leaked, `leaked for ${code}`).toEqual([])
      expect(connector.isConnected(), `still connected for ${code}`).toBe(false)
    }
  })

  it('a disconnect() landing on the new init() await leaves no socket and no leak', async () => {
    hoisted.deferInit = true
    const connector = makeConnector()

    let outcome: unknown
    const leaked = await captureUnhandled(async () => {
      const connecting = connector.connect().catch((e: unknown) => e)
      // connect() is now parked inside init(). Tear down underneath it.
      await Promise.resolve()
      await connector.disconnect()
      hoisted.pendingInits.forEach((d) => d.resolve())
      outcome = await connecting
    })

    expect(leaked).toEqual([])
    expect(connector.isConnected()).toBe(false)
    // connect() still reaches start() — the existing post-start race guard is
    // what closes the now-ownerless socket and fails the connect. What matters
    // is that the new init() await neither leaks nor strands a live socket.
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/disconnected during connect/)
    const client = hoisted.receivers[0].client as { disconnect: { mock: { calls: unknown[] } } }
    expect(client.disconnect.mock.calls.length).toBeGreaterThan(0)
  })

  it('a healthy token connects cleanly with nothing left unobserved', async () => {
    const connector = makeConnector()

    const leaked = await captureUnhandled(async () => { await connector.connect() })

    expect(leaked).toEqual([])
    expect(connector.isConnected()).toBe(true)

    await connector.disconnect()
  })
})
