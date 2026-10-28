import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { serve } from '@hono/node-server'
import { bindServerWithRetry } from './server-bind'

vi.mock('@hono/node-server', () => ({ serve: vi.fn() }))

const mockedServe = vi.mocked(serve)
const fetch = vi.fn() as unknown as Parameters<typeof bindServerWithRetry>[0]

/**
 * Script `serve()` so each attempt either binds (invokes the listening callback)
 * or fails (fires the 'error' handler) depending on whether its port is "busy".
 * The error is fired on a timer so it lands AFTER the helper has registered its
 * `server.once('error', ...)` handler (which happens right after serve returns),
 * mirroring how a real EADDRINUSE arrives asynchronously.
 */
function scriptServe(isBusy: (port: number) => boolean, errorCode = 'EADDRINUSE') {
  mockedServe.mockImplementation(((options: { port: number }, listeningCb?: (info: { port: number }) => void) => {
    const errorHandlers: Array<(err: NodeJS.ErrnoException) => void> = []
    const server = {
      once: vi.fn((event: string, cb: (err: NodeJS.ErrnoException) => void) => {
        if (event === 'error') errorHandlers.push(cb)
        return server
      }),
      off: vi.fn(),
      close: vi.fn(),
    }
    setTimeout(() => {
      if (isBusy(options.port)) {
        errorHandlers.forEach((h) => h({ code: errorCode } as NodeJS.ErrnoException))
      } else {
        listeningCb?.({ port: options.port })
      }
    }, 0)
    return server
  }) as unknown as typeof serve)
}

const boundPorts = () => mockedServe.mock.calls.map((c) => (c[0] as { port: number }).port)

describe('bindServerWithRetry', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('binds the start port when it is free', async () => {
    scriptServe(() => false)

    const { port } = await bindServerWithRetry(fetch, { startPort: 47891 })

    expect(port).toBe(47891)
    expect(mockedServe).toHaveBeenCalledTimes(1)
  })

  it('advances to the next port on EADDRINUSE and binds the first free one', async () => {
    const busy = new Set([47891, 47892])
    scriptServe((p) => busy.has(p))

    const { port } = await bindServerWithRetry(fetch, { startPort: 47891 })

    expect(port).toBe(47893)
    expect(boundPorts()).toEqual([47891, 47892, 47893])
  })

  it('rejects after exhausting maxAttempts (all ports in use)', async () => {
    scriptServe(() => true)

    await expect(
      bindServerWithRetry(fetch, { startPort: 47891, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(mockedServe).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on a non-EADDRINUSE error — it surfaces it as-is', async () => {
    scriptServe(() => true, 'EACCES')

    await expect(
      bindServerWithRetry(fetch, { startPort: 47891 }),
    ).rejects.toMatchObject({ code: 'EACCES' })
    expect(mockedServe).toHaveBeenCalledTimes(1)
  })

  it('closes the failed server before retrying (no leaked half-bound server)', async () => {
    const servers: Array<{ close: ReturnType<typeof vi.fn> }> = []
    mockedServe.mockImplementation(((options: { port: number }, listeningCb?: (info: { port: number }) => void) => {
      const errorHandlers: Array<(err: NodeJS.ErrnoException) => void> = []
      const server = {
        once: vi.fn((event: string, cb: (err: NodeJS.ErrnoException) => void) => {
          if (event === 'error') errorHandlers.push(cb)
          return server
        }),
        off: vi.fn(),
        close: vi.fn(),
      }
      servers.push(server)
      setTimeout(() => {
        if (options.port === 47891) errorHandlers.forEach((h) => h({ code: 'EADDRINUSE' } as NodeJS.ErrnoException))
        else listeningCb?.({ port: options.port })
      }, 0)
      return server
    }) as unknown as typeof serve)

    await bindServerWithRetry(fetch, { startPort: 47891 })

    expect(servers[0].close).toHaveBeenCalled()
    expect(servers[1].close).not.toHaveBeenCalled()
  })

  it('passes fetch, port and hostname through to serve', async () => {
    scriptServe(() => false)

    await bindServerWithRetry(fetch, { startPort: 47891, hostname: '127.0.0.1' })

    expect(mockedServe).toHaveBeenCalledWith(
      expect.objectContaining({ fetch, port: 47891, hostname: '127.0.0.1' }),
      expect.any(Function),
    )
  })

  it('defaults hostname to 0.0.0.0', async () => {
    scriptServe(() => false)

    await bindServerWithRetry(fetch, { startPort: 47891 })

    expect(mockedServe).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '0.0.0.0' }),
      expect.any(Function),
    )
  })
})
