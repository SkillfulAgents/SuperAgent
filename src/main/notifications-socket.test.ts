import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, type ClientOptions } from 'ws'

vi.mock('@shared/lib/auth/trusted-origins', () => ({ getTrustedOrigins: () => ['https://app.acme.example'] }))
vi.mock('@shared/lib/agent-actor', () => ({ agentCatalog: {}, agentRegistry: {} }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/services/notification-service', () => ({ getAccessibleAgentSlugs: vi.fn() }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { GlobalFeed, globalFeed, type FeedTransport, type GlobalFeedEvent, type GlobalFeedListener } from '@shared/lib/notifications/global-feed'
import { setupAgentSockets } from './agent-socket'

// One bus every process reaches, as a deployment's feed hub would be.
const busListeners = new Set<GlobalFeedListener>()
const bus: FeedTransport = {
  publish: (event) => busListeners.forEach((listener) => listener(event)),
  subscribe: (listener) => {
    busListeners.add(listener)
    return () => busListeners.delete(listener)
  },
}

// This process serves the tab; the other one only publishes.
globalFeed.setTransport(bus)
const otherProcess = new GlobalFeed()
otherProcess.setTransport(bus)

let server: http.Server
let url: string

beforeAll(async () => {
  server = http.createServer()
  setupAgentSockets(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/notifications/socket`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

async function openTab(): Promise<{ ws: WebSocket; next: () => Promise<string> }> {
  const ws = new WebSocket(url)
  const messages: string[] = []
  const waiting: Array<(message: string) => void> = []
  ws.on('message', (data) => {
    const message = data.toString()
    const resolve = waiting.shift()
    if (resolve) resolve(message)
    else messages.push(message)
  })
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
  const next = () => {
    const queued = messages.shift()
    return queued !== undefined ? Promise.resolve(queued) : new Promise<string>((resolve) => waiting.push(resolve))
  }
  return { ws, next }
}

describe('notifications socket', () => {
  it('carries an event published in another process to the tab', async () => {
    const tab = await openTab()
    const event: GlobalFeedEvent = { type: 'session_active', agentSlug: 'research', sessionId: 'session-1' }

    otherProcess.publish(event)

    expect(JSON.parse(await tab.next())).toEqual(event)
    tab.ws.close()
  })

  it('answers ping with pong', async () => {
    const tab = await openTab()

    tab.ws.send('ping')

    expect(await tab.next()).toBe('pong')
    tab.ws.close()
  })

  it('stops following the feed when the tab closes', async () => {
    await vi.waitFor(() => expect(busListeners.size).toBe(0))
    const tab = await openTab()
    expect(busListeners.size).toBe(1)

    tab.ws.close()

    await vi.waitFor(() => expect(busListeners.size).toBe(0))
  })

  it('refuses a page from another site, and opens for this server\'s own pages, its trusted origins and the desktop renderer', async () => {
    expect(await handshake({ origin: 'https://attacker.example' })).toBe(403)
    expect(await handshake({ origin: 'https://org-b.acme.example', headers: { host: 'org-a.acme.example' } })).toBe(403)

    expect(await handshake({ origin: 'https://org-a.acme.example', headers: { host: 'org-a.acme.example' } })).toBe(101)
    expect(await handshake({ origin: 'https://app.acme.example' })).toBe(101)
    expect(await handshake({ origin: 'null' })).toBe(101)
  })
})

/** Opens a tab's socket and closes it again: 101 when it opened, else the status it was refused with. */
function handshake(options: ClientOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    ws.once('open', () => {
      ws.close()
      resolve(101)
    })
    ws.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    ws.once('error', reject)
  })
}
