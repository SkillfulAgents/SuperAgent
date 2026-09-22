import type { Locator, Page, WebSocketRoute } from '@playwright/test'
import type { BrowserTabListMessage } from '../../src/shared/lib/browser-stream-protocol'

/** Exercise the real stream decoder and layout with a deterministic page size. */
export async function mockBrowserStream(page: Page, width: number, height: number) {
  const data = await page.evaluate(
    ({ width, height }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#e5efff'
      ctx.fillRect(0, 0, width, height)
      return canvas.toDataURL('image/jpeg').split(',')[1]
    },
    { width, height },
  )
  const frame = Buffer.from(data, 'base64')
  const messages: string[] = []
  let socket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/agents/*/browser/stream', (ws) => {
    socket = ws
    ws.onMessage((message) => messages.push(String(message)))
    ws.send(
      JSON.stringify({
        type: 'tab_list',
        activeTargetId: 'test-page',
        tabs: [{ targetId: 'test-page', index: 0, url: 'https://example.test/', title: 'Test page', active: true }],
      } satisfies BrowserTabListMessage),
    )
    ws.send(JSON.stringify({ type: 'metadata', deviceWidth: width, deviceHeight: height }))
    ws.send(frame)
  })
  // WebSocket routing is installed by an init script and needs a new document.
  await page.reload()
  return { messages, send: (message: object) => socket?.send(JSON.stringify(message)) }
}

/** Checking hit testing avoids Playwright scrolling an offscreen button into view. */
export async function isControlReachable(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return (
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight &&
      element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    )
  })
}
