import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { armAbortSignal } from './arm-abort-signal'

// Real @hono/node-server + real socket disconnects: the adapter creates the
// request AbortController lazily on first `.signal` access and its close
// handler only aborts a controller that already exists, so these tests can't
// run against Hono's in-process `app.request()` helper — the laziness under
// test lives in the node adapter.

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

function serveApp(app: Hono): Promise<number> {
  return new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
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

  // Control: pins the adapter behavior that makes the middleware necessary.
  // If an upgraded @hono/node-server starts observing pre-access hangups on
  // its own, this fails — delete the middleware and this file together.
  it('without arming, the same hangup is permanently missed', async () => {
    const { app, probe } = buildApp(false)
    const port = await serveApp(app)
    await hitAndHangUp(port)
    expect(probe.abortedSeenByHandler).toBe(false)
  })
})
