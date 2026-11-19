// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import {
  cursorCommandDone,
  isKeepingCursor,
  KEEP_ALIVE_INTERVAL_MS,
  KEEP_ALIVE_QUIET_LIMIT_MS,
  keepCursorOnScreen,
  letCursorRest,
  overlaySocketPath,
  sendShowControl,
} from './cursor-keep-alive'

describe('overlaySocketPath', () => {
  // The names agent-desktop 1.1.0 gives these sockets (endpoint.rs).
  it('names the socket under the home, by the hash of the home, the session and the protocol', () => {
    expect(overlaySocketPath('/tmp/state', 'run-1', 501)).toBe('/tmp/state/.cursor-overlay-b62afe8f5ec35ce8.sock')
  })

  it('names it under the user\'s /tmp directory when the path under the home would be too long for a socket', () => {
    const home = '/Users/someone/Library/Application Support/An App With A Long Name/agent-desktop'
    expect(overlaySocketPath(home, 'run-1', 501)).toBe('/tmp/agent-desktop-501/.cursor-overlay-bd55b76ef54846a0.sock')
  })

  it('gives each session its own socket', () => {
    expect(overlaySocketPath('/tmp/state', 'run-1', 501)).not.toBe(overlaySocketPath('/tmp/state', 'run-2', 501))
  })
})

/** An overlay's end of the socket: reads each control to the end of its stream, then answers one byte. */
function overlay(socketPath: string, options: { answers?: boolean } = {}) {
  const controls: unknown[] = []
  const server = net.createServer({ allowHalfOpen: true }, (stream) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      controls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (options.answers === false) stream.destroy()
      else stream.end(Buffer.from([1]))
    })
    stream.on('error', () => {})
  })
  return {
    controls,
    listening: new Promise<void>((resolve) => server.listen(socketPath, resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// A Unix socket, as the macOS overlay has; its path must stay short.
describe.skipIf(process.platform === 'win32')('the keep-alive', () => {
  const home = `/tmp/cursor-keep-alive-${process.pid}`
  const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
  let server: ReturnType<typeof overlay>

  beforeEach(async () => {
    fs.mkdirSync(home, { recursive: true })
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    server = overlay(overlaySocketPath(home, 'ads-1'))
    await server.listening
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(async () => {
    letCursorRest()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
    await server.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  const sent = (count: number) => vi.waitFor(() => expect(server.controls).toHaveLength(count))
  /** Long enough for a control that was sent to have arrived. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  it('sends the overlay a show control and hears its acknowledgement', async () => {
    await expect(sendShowControl(overlaySocketPath(home, 'ads-1'), 'ads-1')).resolves.toBe(true)
    expect(server.controls).toEqual([{ action: 'show', session_id: 'ads-1' }])
  })

  it('reports an overlay that is not there, or does not answer, without failing', async () => {
    await expect(sendShowControl(path.join(home, 'no-such.sock'), 'ads-1')).resolves.toBe(false)

    const silent = overlay(path.join(home, 'silent.sock'), { answers: false })
    await silent.listening
    await expect(sendShowControl(path.join(home, 'silent.sock'), 'ads-1')).resolves.toBe(false)
    await silent.close()
  })

  it('sends a control on every interval from a session\'s command until its cursor is let go', async () => {
    keepCursorOnScreen('session-1', 'ads-1', home)
    expect(isKeepingCursor('session-1')).toBe(true)
    expect(server.controls).toHaveLength(0)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)
    await sent(1)
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)
    await sent(2)
    expect(server.controls[1]).toEqual({ action: 'show', session_id: 'ads-1' })

    letCursorRest('session-1')
    expect(isKeepingCursor('session-1')).toBe(false)
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 3)
    await settle()
    expect(server.controls).toHaveLength(2)
  })

  it('sends nothing while a command sending physical input runs, and resumes when it is done', async () => {
    keepCursorOnScreen('session-1', 'ads-1', home, true)
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 2)
    await settle()
    expect(server.controls).toHaveLength(0)

    cursorCommandDone('session-1')
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)
    await sent(1)
  })

  it('lets the cursor go once no command has run for the quiet limit, and keeps it while commands keep coming', async () => {
    keepCursorOnScreen('session-1', 'ads-1', home)
    vi.advanceTimersByTime(KEEP_ALIVE_QUIET_LIMIT_MS - KEEP_ALIVE_INTERVAL_MS)
    expect(isKeepingCursor('session-1')).toBe(true)

    // A later command starts the limit again.
    keepCursorOnScreen('session-1', 'ads-1', home)
    vi.advanceTimersByTime(KEEP_ALIVE_QUIET_LIMIT_MS - KEEP_ALIVE_INTERVAL_MS)
    expect(isKeepingCursor('session-1')).toBe(true)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 2)
    expect(isKeepingCursor('session-1')).toBe(false)
  })

  it('follows a session to its new agent-desktop session', async () => {
    const next = overlay(overlaySocketPath(home, 'ads-2'))
    await next.listening
    keepCursorOnScreen('session-1', 'ads-1', home)
    keepCursorOnScreen('session-1', 'ads-2', home)

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)
    await vi.waitFor(() => expect(next.controls).toEqual([{ action: 'show', session_id: 'ads-2' }]))
    expect(server.controls).toHaveLength(0)
    await next.close()
  })

  it('keeps no cursor where the overlay is not reached this way', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    keepCursorOnScreen('session-1', 'ads-1', home)
    expect(isKeepingCursor('session-1')).toBe(false)
  })
})
