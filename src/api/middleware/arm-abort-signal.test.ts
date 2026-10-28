import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import { createRequire } from 'node:module'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { armAbortSignal } from './arm-abort-signal'

// Real adapters + socket disconnects: node-server 2 replays a hangup when the
// signal is first accessed. Vite still resolves node-server 1, which needs the
// middleware to arm it before asynchronous auth work. Resolve through the
// plugin so this follows its installed dependency rather than a hoisting path.
const require = createRequire(import.meta.url)
const requireFromVite = createRequire(require.resolve('@hono/vite-dev-server'))
const { serve: serveDevelopment } = requireFromVite('@hono/node-server') as typeof import('@hono/node-server')

interface Probe {
  abortedSeenByHandler?: boolean
}

function buildApp(withArming: boolean): { app: Hono; probe: Probe } {
  const app = new Hono()
  if (withArming) app.use('*', armAbortSignal)
  const probe: Probe = {}
  app.get('/probe', async (c) => {
    // Async pre-work before the route touches the signal — the window in which
    // the real /messages route awaits auth and session-existence checks.
    await new Promise((r) => setTimeout(r, 200))
    const signal = c.req.raw.signal
    // Give a late-created controller every chance to fire before we look.
    await new Promise((r) => setTimeout(r, 100))
    probe.abortedSeenByHandler = signal.aborted
    return c.text('done')
  })
  return { app, probe }
}

let server: ServerType | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

function serveApp(app: Hono, adapter = serve): Promise<number> {
  return new Promise((resolve) => {
    server = adapter({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
      resolve(info.port)
    )
  })
}

// Connect, send the request, then destroy the socket while the handler is
// still inside its pre-signal await.
async function hitAndHangUp(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /probe HTTP/1.1\r\nHost: t\r\n\r\n')
      setTimeout(() => sock.destroy(), 50)
    })
    sock.on('error', () => {})
    sock.on('close', () => resolve())
  })
  // Let the handler run to completion and record what it saw.
  await new Promise((r) => setTimeout(r, 400))
}

describe('armAbortSignal', () => {
  it('a hangup during pre-signal awaits is observed once the signal was armed up front', async () => {
    const { app, probe } = buildApp(true)
    const port = await serveApp(app)
    await hitAndHangUp(port)
    expect(probe.abortedSeenByHandler).toBe(true)
  })

  it('the production adapter replays a hangup even before the signal is accessed', async () => {
    const { app, probe } = buildApp(false)
    const port = await serveApp(app)
    await hitAndHangUp(port)
    expect(probe.abortedSeenByHandler).toBe(true)
  })

  it.each([true, false])('the Vite adapter observes an early hangup only with arming=%s', async (withArming) => {
    const { app, probe } = buildApp(withArming)
    const port = await serveApp(app, serveDevelopment)
    await hitAndHangUp(port)
    expect(probe.abortedSeenByHandler).toBe(withArming)
  })
})
