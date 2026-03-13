/**
 * Browser scenario for E2E testing.
 *
 * Launches a real Chromium (from Playwright) in headless mode, connects via CDP,
 * starts screencast, and streams frames through a mock WS server that the
 * browser-stream-proxy connects to — exercising the full streaming pipeline.
 *
 * This file is only imported when E2E_MOCK=true && E2E_CHROMIUM_PATH is set.
 */

import { spawn, type ChildProcess } from 'child_process'
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import net from 'net'
import type { MockScenario, MockContainerClient } from './mock-container-client'

interface BrowserState {
  httpServer: http.Server
  wss: WebSocketServer
  cdpWs: WebSocket | null
  chromeProcess: ChildProcess | null
  port: number
}

// Track active browser instances for cleanup
const activeBrowsers = new Map<string, BrowserState>()

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForCDP(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // CDP not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`)
}

export class BrowserScenario implements MockScenario {
  execute(sessionId: string, client: MockContainerClient, userMessage: string): void {
    const url = userMessage.replace(/^browse\s+/i, '').trim() || 'https://example.com'

    // Emit message_start immediately so the session appears active
    client.emitStreamMessage(sessionId, {
      type: 'stream_event',
      content: { type: 'stream_event', event: { type: 'message_start' } },
    })

    this.launchBrowser(sessionId, client, url).catch((err) => {
      console.error('[BrowserScenario] Failed to launch browser:', err)
      client.emitStreamMessage(sessionId, {
        type: 'result',
        content: { type: 'result', subtype: 'error', error: String(err) },
      })
    })
  }

  private async launchBrowser(
    sessionId: string,
    client: MockContainerClient,
    url: string,
  ): Promise<void> {
    const chromiumPath = process.env.E2E_CHROMIUM_PATH
    if (!chromiumPath) {
      throw new Error('E2E_CHROMIUM_PATH not set — cannot launch browser for E2E test')
    }

    // 1. Find free ports for mock WS server and Chrome CDP
    const [mockPort, cdpPort] = await Promise.all([findFreePort(), findFreePort()])

    // 2. Start mock HTTP + WS server that the browser-stream-proxy will connect to
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/browser/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ active: true, sessionId }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const wss = new WebSocketServer({ server: httpServer, path: '/browser/stream' })

    // Buffer the last frame so late-connecting WS clients (the browser-stream-proxy)
    // get an immediate frame even if the page is static and CDP stopped sending.
    let lastMetadataJson: string | null = null
    let lastFrameBuffer: Buffer | null = null

    wss.on('connection', (ws) => {
      console.log('[BrowserScenario] WS client connected to mock stream')
      // Send the buffered frame immediately so the client doesn't wait
      if (lastMetadataJson && lastFrameBuffer) {
        ws.send(lastMetadataJson)
        ws.send(lastFrameBuffer)
      }
    })

    await new Promise<void>((resolve) => {
      httpServer.listen(mockPort, () => {
        console.log(`[BrowserScenario] Mock WS server on port ${mockPort}`)
        resolve()
      })
    })

    const state: BrowserState = {
      httpServer,
      wss,
      cdpWs: null,
      chromeProcess: null,
      port: mockPort,
    }
    activeBrowsers.set(sessionId, state)

    // 3. Launch Chromium in headless mode
    const chrome = spawn(
      chromiumPath,
      [
        `--remote-debugging-port=${cdpPort}`,
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=/tmp/e2e-browser-${Date.now()}`,
      ],
      { detached: false, stdio: 'pipe' },
    )

    state.chromeProcess = chrome
    chrome.on('exit', (code) => {
      console.log(`[BrowserScenario] Chrome exited with code ${code}`)
    })

    // 4. Wait for CDP endpoint to become available
    await waitForCDP(cdpPort)

    // 5. Get a PAGE-level CDP WebSocket URL.
    //    Page.startScreencast only works on page targets, not the browser target.
    //    /json returns the list of page targets; /json/version returns the browser target.
    const pagesRes = await fetch(`http://127.0.0.1:${cdpPort}/json`)
    const pages = (await pagesRes.json()) as Array<{ webSocketDebuggerUrl: string; type: string }>
    const pageTarget = pages.find((p) => p.type === 'page')
    if (!pageTarget) {
      throw new Error('No page target found in Chrome')
    }

    // 6. Connect to the page-level CDP target
    const cdpWs = new WebSocket(pageTarget.webSocketDebuggerUrl)
    state.cdpWs = cdpWs

    await new Promise<void>((resolve, reject) => {
      cdpWs.on('open', resolve)
      cdpWs.on('error', reject)
    })

    let cmdId = 1
    const cdpSend = (method: string, params?: Record<string, unknown>) => {
      cdpWs.send(JSON.stringify({ id: cmdId++, method, params }))
    }

    // 7. Enable page events and navigate
    cdpSend('Page.enable')
    cdpSend('Page.navigate', { url })

    // Wait a moment for navigation
    await new Promise((r) => setTimeout(r, 2000))

    // 8. Start screencast on the page target
    cdpSend('Page.startScreencast', {
      format: 'jpeg',
      quality: 50,
      maxWidth: 1280,
      maxHeight: 720,
    })

    // 9. Forward screencast frames to connected WS clients (the browser-stream-proxy)
    cdpWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.method === 'Page.screencastFrame') {
          const frameBuffer = Buffer.from(msg.params.data, 'base64')
          const meta = msg.params.metadata || {}

          const metadataJson = JSON.stringify({
            type: 'metadata',
            deviceWidth: meta.deviceWidth || 1280,
            deviceHeight: meta.deviceHeight || 720,
          })

          // Buffer for late-connecting clients
          lastMetadataJson = metadataJson
          lastFrameBuffer = frameBuffer

          wss.clients.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(metadataJson)
              ws.send(frameBuffer)
            }
          })

          // Ack the frame so CDP keeps sending
          cdpSend('Page.screencastFrameAck', {
            sessionId: msg.params.sessionId,
          })
        }
      } catch {
        // Ignore parse errors
      }
    })

    // 10. Update container manager cached status to point to the mock WS server's port.
    //     browser-stream-proxy reads getCachedInfo() to know where to connect.
    //     Dynamic import to avoid circular dependency (mock-container-client ← client-factory ← container-manager).
    const { containerManager } = await import('./container-manager')
    const agentId = client.getAgentId()
    containerManager.updateCachedStatus(agentId, 'running', mockPort)

    // 11. Track active browser on the mock client (for /browser/status responses)
    client.setActiveBrowserSession(sessionId)

    // 12. Write user message to JSONL
    client.writeJsonlEntry(sessionId, {
      type: 'user',
      message: { content: `browse ${url}` },
      timestamp: new Date().toISOString(),
    })

    // 13. Emit browser_active via SSE so the frontend shows BrowserPreview
    client.emitStreamMessage(sessionId, {
      type: 'browser_active',
      content: { type: 'browser_active', active: true, sessionId },
    })

    console.log(`[BrowserScenario] Browser launched and streaming for ${url}`)
  }
}

/**
 * Clean up a specific browser scenario (kill Chrome, close WS server).
 */
export function cleanupBrowserSession(sessionId: string): void {
  const state = activeBrowsers.get(sessionId)
  if (!state) return

  console.log(`[BrowserScenario] Cleaning up session ${sessionId}`)
  activeBrowsers.delete(sessionId)

  try { state.cdpWs?.close() } catch { /* best-effort cleanup */ }
  try { state.chromeProcess?.kill() } catch { /* best-effort cleanup */ }
  try { state.wss.close() } catch { /* best-effort cleanup */ }
  try { state.httpServer.close() } catch { /* best-effort cleanup */ }
}

/**
 * Clean up ALL active browser scenarios.
 */
export function cleanupAllBrowserSessions(): void {
  for (const sessionId of activeBrowsers.keys()) {
    cleanupBrowserSession(sessionId)
  }
}

// Ensure cleanup on process exit
if (process.env.E2E_MOCK === 'true') {
  process.on('exit', cleanupAllBrowserSessions)
}
