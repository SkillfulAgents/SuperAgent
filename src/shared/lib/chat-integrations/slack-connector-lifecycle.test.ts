import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// SlackConnector socket lifecycle.
//
// The old connector set `connected = true` after app.start() and only ever set
// it false in disconnect(), so a dead socket was invisible to the manager's
// health check ("stops responding" with an active badge). It also left
// reconnects to @slack/socket-mode's internal loop, which leaks unrecoverable
// failures as unhandled promise rejections (delayReconnectAttempt has no
// .catch) — fatal at the app level.
//
// The rebuilt connector owns its Socket Mode lifecycle:
//   1. the receiver is constructed with autoReconnectEnabled: false — the leaky
//      internal reconnect path must never run,
//   2. isConnected() tracks the client's connected/disconnected state events,
//   3. an unexpected disconnect schedules our own exponential-backoff restart,
//   4. transient restart failures keep backing off; success resets,
//   5. disconnect() stops the loop — no reconnect after an intentional stop,
//   6. a failed INITIAL connect never leaves a reconnect loop behind (the
//      manager owns retries for that connector object's whole lifetime),
//   7. an unrecoverable auth error stops the loop and surfaces via onError.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  receivers: [] as Array<{ opts: Record<string, unknown>; client: unknown }>,
  apps: [] as Array<{ opts: Record<string, unknown> }>,
  failNextClientStart: false,
}))

vi.mock('@slack/bolt', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeClient extends EventEmitter {
    start = vi.fn(async () => {
      if (hoisted.failNextClientStart) {
        hoisted.failNextClientStart = false
        throw new Error('simulated start failure')
      }
      this.emit('connected')
    })

    disconnect = vi.fn(async () => {
      this.emit('disconnected')
    })
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
    client = {
      auth: { test: vi.fn(async () => ({ ok: true, user_id: 'U-bot', user: 'bot', team: 'T-test' })) },
    }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.receiver = opts.receiver as SocketModeReceiver
      hoisted.apps.push(this)
    }
    event(): void {}
    message(): void {}
    action(): void {}
    async start(): Promise<void> { await this.receiver.client.start() }
    async stop(): Promise<void> { await this.receiver.client.disconnect() }
  }

  return { App, SocketModeReceiver }
})

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import { SlackConnector } from './slack-connector'

interface FakeClientHandle {
  start: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  emit(event: string): boolean
}

function lastClient(): FakeClientHandle {
  const receiver = hoisted.receivers.at(-1)
  if (!receiver) throw new Error('no receiver constructed')
  return receiver.client as FakeClientHandle
}

function makeConnector(): SlackConnector {
  return new SlackConnector({ botToken: 'xoxb-test', appToken: 'xapp-test' })
}

function unrecoverableAuthError(): Error {
  const err = new Error('An API error occurred: invalid_auth') as Error & {
    code: string
    data: { ok: false; error: string }
  }
  err.code = 'slack_webapi_platform_error'
  err.data = { ok: false, error: 'invalid_auth' }
  return err
}

beforeEach(() => {
  vi.useFakeTimers()
  hoisted.receivers.length = 0
  hoisted.apps.length = 0
  hoisted.failNextClientStart = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('SlackConnector socket lifecycle', () => {
  it('owns the receiver with autoReconnectEnabled: false (the leaky internal loop must never run)', async () => {
    const connector = makeConnector()
    await connector.connect()

    expect(hoisted.receivers).toHaveLength(1)
    const receiverOpts = hoisted.receivers[0].opts
    expect(receiverOpts.appToken).toBe('xapp-test')
    expect(receiverOpts.autoReconnectEnabled).toBe(false)

    // The App must be built AROUND our receiver, not its own.
    expect(hoisted.apps).toHaveLength(1)
    expect(hoisted.apps[0].opts.receiver).toBe(hoisted.receivers[0])
    expect(hoisted.apps[0].opts.token).toBe('xoxb-test')

    expect(connector.isConnected()).toBe(true)
  })

  it('tracks the socket state: an unexpected disconnect flips isConnected() to false', async () => {
    const connector = makeConnector()
    await connector.connect()
    expect(connector.isConnected()).toBe(true)

    lastClient().emit('disconnected')

    expect(connector.isConnected()).toBe(false)
  })

  it('restarts the socket with backoff after an unexpected disconnect', async () => {
    const connector = makeConnector()
    await connector.connect()
    const client = lastClient()
    client.start.mockClear()

    client.emit('disconnected')
    expect(connector.isConnected()).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(client.start).toHaveBeenCalledTimes(1)
    // The fake start emits 'connected' — state must recover.
    expect(connector.isConnected()).toBe(true)
  })

  it('keeps backing off on transient failures and resets after success', async () => {
    const connector = makeConnector()
    await connector.connect()
    const client = lastClient()
    client.start.mockClear()

    const transient = new Error('A request error occurred: ENOTFOUND') as Error & { code: string }
    transient.code = 'slack_webapi_request_error'
    client.start
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)

    client.emit('disconnected')

    await vi.advanceTimersByTimeAsync(1_000) // attempt 1 fails
    expect(client.start).toHaveBeenCalledTimes(1)
    expect(connector.isConnected()).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000) // attempt 2 fails
    expect(client.start).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(4_000) // attempt 3 succeeds
    expect(client.start).toHaveBeenCalledTimes(3)
    expect(connector.isConnected()).toBe(true)

    // Success reset the ladder: the next outage starts back at the base delay.
    client.start.mockClear()
    client.emit('disconnected')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.start).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect after an intentional disconnect()', async () => {
    const connector = makeConnector()
    await connector.connect()
    const client = lastClient()
    client.start.mockClear()

    await connector.disconnect()
    expect(connector.isConnected()).toBe(false)

    // app.stop() emitted 'disconnected'; a pending timer must not restart us.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.start).not.toHaveBeenCalled()
  })

  it('a failed initial connect leaves no reconnect loop behind', async () => {
    hoisted.failNextClientStart = true
    const connector = makeConnector()

    await expect(connector.connect()).rejects.toThrow('Slack Socket Mode failed to start')

    // The manager discarded this connector; a late 'disconnected' from the
    // half-open socket must not start a zombie loop on it.
    const client = lastClient()
    client.start.mockClear()
    client.emit('disconnected')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.start).not.toHaveBeenCalled()
  })

  it('stops the loop and surfaces onError for an unrecoverable auth error', async () => {
    const connector = makeConnector()
    await connector.connect()
    const client = lastClient()
    client.start.mockClear()
    client.start.mockRejectedValue(unrecoverableAuthError())

    const errors: Error[] = []
    connector.onError((err) => { errors.push(err) })

    client.emit('disconnected')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(client.start).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('invalid_auth')

    // Dead workspace: retrying is pointless, the loop must stop for good.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(client.start).toHaveBeenCalledTimes(1)
  })
})
