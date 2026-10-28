import { chromium, expect, test, type Locator } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { SessionPage } from '../pages/session.page'

async function expectDecodedImage(image: Locator) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    width: element.naturalWidth,
    height: element.naturalHeight,
  })), { timeout: 15_000 }).toEqual({ complete: true, width: 16, height: 16 })
}

test('Electron decodes HEIC/HEIF previews and retries a failed drawer preview', async ({ request }, testInfo) => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.E2E_ELECTRON_DEBUG_PORT ?? '47993'}`)
  try {
    const context = browser.contexts()[0]
    // DevTools and the hidden quick-dispatch window are also CDP pages.
    const appWindow = () => context.pages().find(page => {
      const url = new URL(page.url())
      return url.pathname === '/' || url.pathname.endsWith('/index.html')
    })
    await expect.poll(() => !!appWindow(), { timeout: 15_000 }).toBe(true)
    const page = appWindow()!
    await page.bringToFront()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 60_000 })
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Electron/')

    const apiUrl = await page.evaluate(() => window.electronAPI!.getApiUrl())
    const created = await request.post(`${apiUrl}/api/agents`, { data: { name: 'HEIC preview regression' } })
    expect(created.ok()).toBeTruthy()
    const { slug } = z.object({ slug: z.string() }).parse(await created.json())
    const agentUrl = new URL(page.url())
    agentUrl.hash = `/agents/${slug}`
    await page.goto(agentUrl.href)

    const session = new SessionPage(page)
    await session.sendMessage('hello')
    await session.waitForResponse(15_000)
    await session.waitForInputEnabled()

    // This is the real HEIC fixture also exercised by the inline-route tests.
    const original = await readFile(path.join(__dirname, '../fixtures/tiny.heic'))
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(
      ['heic', 'heif'].map(extension => ({ name: `photo.${extension}`, mimeType: `image/${extension}`, buffer: original })),
    )
    for (const extension of ['heic', 'heif']) {
      const image = page.getByTestId('attachment-preview').getByRole('img', { name: `photo.${extension}`, exact: true })
      await expectDecodedImage(image)
      const previewUrl = (await image.getAttribute('src'))!
      const preview = await page.request.get(previewUrl)
      expect(preview.status()).toBe(200)
      expect(preview.headers()['content-type']).toBe('image/jpeg')
      expect((await preview.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))

      // A single upload is saved as a JPEG, so the download is the converted file.
      const downloadUrl = new URL(previewUrl)
      downloadUrl.searchParams.delete('inline')
      const download = await page.request.get(downloadUrl.href)
      expect(download.ok()).toBeTruthy()
      expect((await download.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    }

    await session.sendMessage('Check these photos')
    await session.waitForUserMessageCount(2, 15_000)
    const pills = page.getByTestId('file-pill')
    await expect(pills).toHaveCount(2)
    for (const pill of await pills.all()) await expectDecodedImage(pill.getByRole('img'))

    // Only fail the drawer's versioned request. Reopening the same attachment
    // changes its URL while preserving the tab and ImageRenderer instance.
    let failDrawerOnce = true
    await page.route('**/api/agents/*/files/**', async route => {
      const url = new URL(route.request().url())
      if (failDrawerOnce && url.searchParams.has('v') && url.searchParams.get('inline') === 'true') {
        failDrawerOnce = false
        await route.fulfill({ status: 503, body: 'Temporary preview failure' })
      } else {
        await route.continue()
      }
    })
    await pills.first().click()
    const drawer = page.getByTestId('file-preview-tray')
    await expect(drawer.getByText('Image preview unavailable')).toBeVisible()
    await pills.first().click()
    await expectDecodedImage(drawer.getByRole('img'))
    await expect(drawer.getByText('Image preview unavailable')).toHaveCount(0)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(colorScheme === 'dark')
      const screenshot = testInfo.outputPath(`heic-preview-${colorScheme}.png`)
      await page.screenshot({ path: screenshot, animations: 'disabled' })
      await testInfo.attach(`HEIC preview (${colorScheme})`, { path: screenshot, contentType: 'image/png' })
    }
  } finally {
    await browser.close()
  }
})
