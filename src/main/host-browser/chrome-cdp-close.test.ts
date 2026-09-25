import http from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { requestChromeClose } from './chrome-cdp-close'

type Behavior = (message: { id: number; method: string }, socket: WebSocket) => void

const servers: Array<() => Promise<void>> = []

/** A local stand-in for Chrome's CDP HTTP + WebSocket endpoints. */
async function fakeChrome(behavior: Behavior) {
  let port = 0
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }))
  })
  const wss = new WebSocketServer({ server })
  const received: string[] = []
  wss.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    received.push(message.method)
    behavior(message, socket)
  }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  const close = () => new Promise<void>((resolve) => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.close(() => resolve())
  })
  servers.push(close)
  return { url: `http://127.0.0.1:${port}`, received, close }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()))
})

describe('requestChromeClose', () => {
  it('sends Browser.close and resolves true when Chrome replies', async () => {
    const chrome = await fakeChrome((message, socket) => socket.send(JSON.stringify({ id: message.id, result: {} })))
    expect(await requestChromeClose(chrome.url)).toBe(true)
    expect(chrome.received).toEqual(['Browser.close'])
  })

  it('treats a socket dropped after the command as accepted', async () => {
    const chrome = await fakeChrome((_message, socket) => socket.terminate())
    expect(await requestChromeClose(chrome.url)).toBe(true)
  })

  it('resolves false when the CDP endpoint is unreachable', async () => {
    const chrome = await fakeChrome(() => {})
    await chrome.close()
    expect(await requestChromeClose(chrome.url, 500)).toBe(false)
  })

  it('resolves false when Chrome neither replies nor exits', async () => {
    const chrome = await fakeChrome(() => {})
    expect(await requestChromeClose(chrome.url, 200)).toBe(false)
  })
})
