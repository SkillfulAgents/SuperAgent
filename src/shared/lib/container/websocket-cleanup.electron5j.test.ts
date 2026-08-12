/**
 * ELECTRON-5J — "WebSocket was closed before the connection was established".
 *
 * Tearing a stream socket down while its handshake is still in flight aborts
 * the handshake, and `ws` reports that abort as an 'error' event on the NEXT
 * TICK. Two paths turned our own abort into a reported failure:
 *
 *   1. `unsubscribe()` called `ws.close()` on a CONNECTING socket. The abort
 *      error reached `rejectReady`, and every caller that discards `ready`
 *      (the reconnect paths) turned it into an unhandled rejection.
 *   2. `terminateWebSocketConnections()` called `removeAllListeners()` and
 *      then `terminate()`. With no 'error' listener left, EventEmitter
 *      rethrows the next-tick abort error as an *uncaught exception* — the
 *      surrounding try/catch cannot catch it because the emit is async.
 *
 * Cleanup is now state-aware (CONNECTING aborts locally and suppresses only
 * that expected error, OPEN closes gracefully, CLOSING/CLOSED just untrack)
 * and idempotent. Genuine remote failures must still be reported.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import net from 'net'
import { WebSocketServer } from 'ws'
import { BaseContainerClient } from './base-container-client'
import type { ContainerInfo, ContainerConfig } from './types'

class RunningTestClient extends BaseContainerClient {
  constructor(private readonly port: number) {
    super({ agentId: 'test-agent' } as ContainerConfig)
  }
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'running', port: this.port }
  }
  /** stop() does far more than socket teardown; exercise just that part. */
  public terminateSockets(): void {
    this.terminateWebSocketConnections()
  }
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** Records process-level fallout that Sentry would otherwise report. */
function watchProcessFaults() {
  const unhandled: unknown[] = []
  const uncaught: unknown[] = []
  const onRejection = (reason: unknown) => unhandled.push(reason)
  const onException = (error: unknown) => uncaught.push(error)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return {
    unhandled,
    uncaught,
    dispose: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    },
  }
}

describe('stream socket cleanup while CONNECTING (ELECTRON-5J)', () => {
  // A raw TCP server that accepts the connection and never answers the
  // upgrade request, so the client socket stays in CONNECTING.
  let hangingServer: net.Server
  let accepted: net.Socket[]
  let port: number
  let faults: ReturnType<typeof watchProcessFaults>

  beforeEach(async () => {
    faults = watchProcessFaults()
    accepted = []
    hangingServer = net.createServer((socket) => {
      // Never answers the upgrade request; held so close() can reap it.
      accepted.push(socket)
    })
    await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve))
    port = (hangingServer.address() as net.AddressInfo).port
  })

  afterEach(async () => {
    faults.dispose()
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()))
  })

  it('unsubscribe() aborts the pending handshake without an unhandled rejection or emitted error', async () => {
    const client = new RunningTestClient(port)
    const emitted: unknown[] = []
    client.on('error', (err) => emitted.push(err))

    const { unsubscribe } = client.subscribeToStream('sess-connecting', () => {})
    await tick(30) // let setupWebSocket create the socket

    unsubscribe()
    await tick()

    expect(faults.unhandled).toHaveLength(0)
    expect(faults.uncaught).toHaveLength(0)
    // Our own abort is not a session failure — nothing to report.
    expect(emitted).toHaveLength(0)
  })

  it('repeated unsubscribe() is safe', async () => {
    const client = new RunningTestClient(port)
    client.on('error', () => {})

    const { unsubscribe } = client.subscribeToStream('sess-repeat', () => {})
    await tick(30)

    expect(() => {
      unsubscribe()
      unsubscribe()
      unsubscribe()
    }).not.toThrow()
    await tick()

    expect(faults.unhandled).toHaveLength(0)
    expect(faults.uncaught).toHaveLength(0)
  })

  it('terminateWebSocketConnections() does not raise an uncaught exception', async () => {
    const client = new RunningTestClient(port)
    client.on('error', () => {})

    const { ready } = client.subscribeToStream('sess-terminate', () => {})
    ready.catch(() => {})
    await tick(30)

    client.terminateSockets()
    await tick()

    expect(faults.uncaught).toHaveLength(0)
    expect(faults.unhandled).toHaveLength(0)
  })
})

describe('stream socket cleanup once established (ELECTRON-5J)', () => {
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    port = (wss.address() as net.AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('closes an OPEN socket gracefully and reports the disconnect once', async () => {
    const client = new RunningTestClient(port)
    const serverClosed = new Promise<void>((resolve) => {
      wss.on('connection', (socket) => socket.on('close', () => resolve()))
    })
    const messages: string[] = []

    const { unsubscribe, ready } = client.subscribeToStream('sess-open', (m) => messages.push(m.type))
    await ready

    unsubscribe()
    await serverClosed
    await tick()

    expect(messages).toContain('connection_closed')
  })
})

describe('remote stream failures are still reported (ELECTRON-5J)', () => {
  it('emits and rejects when the container refuses the connection', async () => {
    // Bind then immediately release the port so connects are refused.
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const deadPort = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const client = new RunningTestClient(deadPort)
    const emitted: unknown[] = []
    client.on('error', (err) => emitted.push(err))

    const { ready } = client.subscribeToStream('sess-refused', () => {})

    await expect(ready).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(emitted).toHaveLength(1)
  })
})
