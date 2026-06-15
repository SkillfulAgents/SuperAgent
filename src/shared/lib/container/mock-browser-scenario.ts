/**
 * Browser scenario for E2E testing.
 *
 * Launches a real Chromium (from Playwright) in headless mode, captures rendered
 * frames from the page, and streams them through a mock WS server that the
 * browser-stream-proxy connects to — exercising the full browser preview
 * pipeline with real browser pixels.
 *
 * This file is only imported when E2E_MOCK=true && E2E_CHROMIUM_PATH is set.
 */

import { chromium, type Browser, type Page } from '@playwright/test'
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import net from 'net'
import type { MockScenario, MockContainerClient } from './mock-container-client'

interface BrowserState {
  httpServer: http.Server
  wss: WebSocketServer
  browser: Browser | null
  page: Page | null
  captureTimer: ReturnType<typeof setInterval> | null
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

    // 1. Find a free port for the mock WS server
    const mockPort = await findFreePort()

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
    // get an immediate frame even if the page is static.
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
      browser: null,
      page: null,
      captureTimer: null,
      port: mockPort,
    }
    activeBrowsers.set(sessionId, state)

    let publishedFrameCount = 0
    const publishFrame = (frameBuffer: Buffer, meta: { deviceWidth?: number; deviceHeight?: number } = {}) => {
      const metadataJson = JSON.stringify({
        type: 'metadata',
        deviceWidth: meta.deviceWidth || 1280,
        deviceHeight: meta.deviceHeight || 720,
      })

      // Buffer for late-connecting clients
      lastMetadataJson = metadataJson
      lastFrameBuffer = frameBuffer
      publishedFrameCount += 1
      if (publishedFrameCount === 1) {
        console.log(`[BrowserScenario] Published first browser frame (${frameBuffer.length} bytes)`)
      }

      wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(metadataJson)
          ws.send(frameBuffer)
        }
      })
    }

    // 3. Launch Chromium via Playwright and stream real rendered page frames.
    // Raw CDP Page.startScreencast currently acknowledges but emits no frames in
    // headless Chrome for Testing on CI-like hosts. Playwright's screenshot path
    // still captures actual browser pixels, which keeps this E2E test meaningful
    // while remaining runnable in GitHub Actions.
    const browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox'],
    })
    state.browser = browser

    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    })
    state.page = page
    await page.goto(url, { waitUntil: 'load', timeout: 15000 })

    const captureBrowserFrame = async () => {
      const frameBuffer = await page.screenshot({
        type: 'jpeg',
        quality: 50,
        animations: 'disabled',
        caret: 'hide',
      })
      const viewport = page.viewportSize()
      publishFrame(frameBuffer, {
        deviceWidth: viewport?.width,
        deviceHeight: viewport?.height,
      })
    }

    await captureBrowserFrame()
    state.captureTimer = setInterval(() => {
      void captureBrowserFrame().catch((error) => {
        console.error('[BrowserScenario] Playwright screenshot failed:', error)
      })
    }, 500)

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
 * Clean up a specific browser scenario (close Chromium, close WS server).
 */
export function cleanupBrowserSession(sessionId: string): void {
  const state = activeBrowsers.get(sessionId)
  if (!state) return

  console.log(`[BrowserScenario] Cleaning up session ${sessionId}`)
  activeBrowsers.delete(sessionId)

  try {
    if (state.captureTimer) clearInterval(state.captureTimer)
  } catch { /* best-effort cleanup */ }
  try {
    void state.page?.close().catch(() => {})
  } catch { /* best-effort cleanup */ }
  try {
    void state.browser?.close().catch(() => {})
  } catch { /* best-effort cleanup */ }
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
