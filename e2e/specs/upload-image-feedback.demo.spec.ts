import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as zlib from 'zlib'

/**
 * A demo, not a guard — it records the composer's image chip through a slow
 * upload so the states it used to drop (waiting, a bar that moves, a failure
 * you can retry) can be watched rather than described. Run it on purpose:
 *
 *   E2E_MOCK=true npx playwright test e2e/specs/upload-image-feedback.demo.spec.ts \
 *     --config playwright.demo.config.ts
 *
 * The upload is slowed with CDP's own bandwidth throttle rather than by
 * stalling a route: the percent comes from XHR's upload progress events, which
 * are done firing by the time a route interceptor sees the request.
 */

/** A valid PNG of `size` bytes: a 1x1 image followed by a padding chunk. */
function bigPng(sizeBytes: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(zlib.crc32(crcInput) >>> 0, 0)
    return Buffer.concat([head, body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0]))
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
  ]
  const used = parts.reduce((n, p) => n + p.length, 0) + 12 /* IEND */
  // PNG decoders stop at IEND, so the padding rides in a private ancillary
  // chunk before it: real bytes on the wire, ignored by the renderer.
  const padding = chunk('prVt', Buffer.alloc(Math.max(0, sizeBytes - used - 12), 0x7a))
  return Buffer.concat([...parts, padding, chunk('IEND', Buffer.alloc(0))])
}

test('composer image chips report waiting, progress and a retryable failure', async ({ page }) => {
  test.setTimeout(180_000)

  const appPage = new AppPage(page)
  const agentPage = new AgentPage(page)
  const sessionPage = new SessionPage(page)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await agentPage.createAgent(`Upload Feedback ${Date.now()}`)
  await sessionPage.sendMessage('hello')
  await sessionPage.waitForResponse(15_000)
  await sessionPage.waitForInputEnabled()

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-upload-demo-'))
  const photos = ['sunset.png', 'harbour.png', 'rooftops.png'].map((name) => {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, bigPng(3 * 1024 * 1024))
    return file
  })

  // Squeeze the uplink so the percent has somewhere to climb through.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 120,
    downloadThroughput: -1,
    uploadThroughput: 180 * 1024,
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(photos)

  const chips = page.getByTestId('attachment-preview')
  await expect(chips).toHaveCount(3)

  // One is uploading; the ones behind it say they are waiting their turn.
  await expect(page.getByTestId('attachment-progress').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('attachment-queued').first()).toBeVisible()

  // Let the bar fill on camera. Its width is the only thing that moves, so
  // that is what we wait on — overlay > Progress track > fill.
  const barFill = page.getByTestId('attachment-progress').first().locator('> div > div')
  await expect
    .poll(async () => {
      const style = await barFill.getAttribute('style').catch(() => null)
      return Number(style?.match(/width:\s*([\d.]+)%/)?.[1] ?? 0)
    }, { timeout: 60_000 })
    .toBeGreaterThan(5)
  // Pacing for the viewer, not synchronization: every real wait here is an expect().
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- let the bar visibly travel
  await page.waitForTimeout(4_000)

  await expect(page.getByTestId('attachment-progress')).toHaveCount(0, { timeout: 120_000 })
  // Pacing for the viewer, not synchronization: every real wait here is an expect().
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- hold on all three finished
  await page.waitForTimeout(1_500)

  // Now the failure path: refuse the next upload, attach one more, and show the
  // retry the picture-only chip used to have no room for.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  let failed = false
  await page.route('**/upload-file*', async (route) => {
    if (!failed) {
      failed = true
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"network down"}' })
      return
    }
    await route.continue()
  })

  const doomed = path.join(tmpDir, 'skyline.png')
  fs.writeFileSync(doomed, bigPng(256 * 1024))
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([doomed])

  const retry = page.getByRole('button', { name: 'Retry upload of skyline.png' })
  await expect(retry).toBeVisible({ timeout: 30_000 })
  // Pacing for the viewer, not synchronization: every real wait here is an expect().
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- let the failure state be read
  await page.waitForTimeout(2_500)

  await retry.click()
  await expect(retry).toBeHidden({ timeout: 30_000 })
  // Pacing for the viewer, not synchronization: every real wait here is an expect().
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- hold on the recovered chip before the cut
  await page.waitForTimeout(2_500)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
