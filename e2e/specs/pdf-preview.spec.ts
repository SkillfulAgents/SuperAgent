import { test, expect, type Page, type Request } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { pdfFixture } from '../helpers/pdf-fixture'
import { timestampedUploadNamePattern } from '../helpers/upload-filename'

const title = 'Quarterly revenue review'
const secondTitle = 'Forecast and next steps'

function filePill(page: Page, name: string) {
  return page.getByTestId('file-pill').filter({ hasText: timestampedUploadNamePattern(name) }).first()
}

function fileTab(page: Page, name: string) {
  return page.getByTestId('file-tab').filter({ hasText: timestampedUploadNamePattern(name) })
}

async function uploadPdfs(page: Page, files = [
  { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
]) {
  const session = new SessionPage(page)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files)
  for (const file of files) {
    await expect(page.getByTestId('attachment-preview').filter({ hasText: file.name })).toBeVisible()
  }
  const repliesBefore = await session.getAssistantMessages().count()
  await session.sendMessage('Review these documents')
  // The setup's "hello" already has a reply. Wait for THIS turn so the
  // optimistic attachment pills cannot unmount halfway through a click.
  await session.waitForAssistantMessageCount(repliesBefore + 1, 15000)
  for (const file of files) await expect(filePill(page, file.name)).toBeVisible()
}

async function expectPage(page: Page, number: number) {
  await expect(page.getByTestId('pdf-renderer').getByText(number === 1 ? title : secondTitle, { exact: true })).toBeVisible()
  await expect(page.getByTestId('pdf-pagination')).toContainText(`${number} / 2`)
  await expect.poll(async () => page.getByTestId('pdf-renderer').locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(100)
}

/** Compare the DOM selection layer to the actual painted glyphs, at the current responsive scale. */
async function expectAlignedText(page: Page) {
  await expect.poll(async () => page.getByTestId('pdf-renderer').evaluate((root, expectedTitle) => {
    const canvas = root.querySelector<HTMLCanvasElement>('canvas')!
    const span = [...root.querySelectorAll('.textLayer span')].find(el => el.textContent === expectedTitle)!
    if (!span || !canvas.width) return false
    const box = canvas.getBoundingClientRect()
    const text = span.getBoundingClientRect()
    const layer = root.querySelector('.textLayer')!.getBoundingClientRect()
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    // The title occupies PDF y=720, 18pt. Restrict to that line so the second line cannot mask drift.
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0, count = 0
    for (let y = Math.floor(canvas.height * 50 / 792); y < Math.ceil(canvas.height * 80 / 792); y++) {
      for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4
        if (pixels[offset + 3] > 0 && pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100) {
          minX = Math.min(minX, x); minY = Math.min(minY, y)
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++
        }
      }
    }
    const sx = box.width / canvas.width, sy = box.height / canvas.height
    const ink = { left: box.left + minX * sx, top: box.top + minY * sy, right: box.left + (maxX + 1) * sx, bottom: box.top + (maxY + 1) * sy }
    return count > 50
      && Math.abs(layer.width - box.width) < 1 && Math.abs(layer.height - box.height) < 1
      && Math.abs(text.left - ink.left) < 3 && Math.abs(text.right - ink.right) < 4
      && text.top <= ink.top + 1 && text.bottom >= ink.bottom - 1
      && ink.top - text.top < text.height * 0.5
  }, title)).toBe(true)
}

test.describe('PDF preview with the real PDF.js worker', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const app = new AppPage(page)
    await app.goto()
    await app.waitForAgentsLoaded()
    await new AgentPage(page).createAgent(`PDF ${testInfo.workerIndex}-${Date.now()}`)
    const session = new SessionPage(page)
    await session.sendMessage('hello')
    await session.waitForResponse(15000)
    await session.waitForInputEnabled()
  })

  test('loads a local worker, paints aligned selectable text and an interactive annotation without a CDN', async ({ page, context }) => {
    const origin = URL.parse(page.url())!.origin
    const external: string[] = []
    const pdfWarnings: string[] = []
    page.on('console', message => {
      if (/fake worker|worker version|API version/.test(message.text())) pdfWarnings.push(message.text())
    })
    await context.route('**/*', route => {
      const url = URL.parse(route.request().url())!
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== origin) {
        external.push(url.href)
        return route.abort()
      }
      return route.continue()
    })
    await uploadPdfs(page)
    const workerPromise = page.waitForEvent('worker', worker => worker.url().includes('pdf.worker'))
    await filePill(page, 'report.pdf').click()
    const worker = await workerPromise
    expect(URL.parse(worker.url())!.origin).toBe(origin)
    expect(await worker.evaluate(() => typeof document)).toBe('undefined')
    await expectPage(page, 1)
    await expectAlignedText(page)
    const link = page.getByTestId('pdf-renderer').locator('a[href="https://example.com/pdf-reference"]')
    await expect(link).toBeVisible()
    await link.click({ trial: true })
    expect(external.filter(url => /pdf|worker|font|cmaps/i.test(url))).toEqual([])
    expect(pdfWarnings).toEqual([])
  })

  test('mouse selection creates quoted page feedback and submit keeps it in the draft', async ({ page }) => {
    await uploadPdfs(page)
    await filePill(page, 'report.pdf').click()
    await expectPage(page, 1)
    const selectedText = page.getByTestId('pdf-renderer').getByText(title, { exact: true })
    const textBox = (await selectedText.boundingBox())!
    await page.mouse.move(textBox.x + 1, textBox.y + textBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(textBox.x + textBox.width - 1, textBox.y + textBox.height / 2, { steps: 15 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(title)
    const overlay = page.locator('[data-comment-overlay]')
    await overlay.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(overlay).toContainText('Page 1')
    await expect(overlay).toContainText(title)
    await overlay.getByPlaceholder('Add your comment...').fill('Please explain this revenue change')
    await overlay.getByRole('button', { name: 'Add', exact: true }).click()
    const tray = page.getByTestId('file-preview-tray')
    await expect(tray).toContainText('Please explain this revenue change')
    const session = new SessionPage(page)
    const before = await session.getUserMessages().count()
    let posts = 0
    page.on('request', request => {
      if (request.method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(request.url())) posts++
    })
    await tray.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(session.getMessageInput()).toContainText(title)
    await expect(session.getMessageInput()).toContainText('Page 1')
    await expect(session.getMessageInput()).toContainText('Please explain this revenue change')
    await expect(session.getMessageInput()).toBeFocused()
    await expect(session.getUserMessages()).toHaveCount(before)
    expect(posts).toBe(0)
  })

  test('pagination, page comments, switching tabs and hiding the pane retain the selected page', async ({ page }) => {
    await uploadPdfs(page, [
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
      { name: 'other.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    ])
    await filePill(page, 'report.pdf').click()
    await expectPage(page, 1)
    await expect(page.getByRole('button', { name: 'Previous PDF page' })).toBeDisabled()
    await page.getByRole('button', { name: 'Next PDF page' }).click()
    await expectPage(page, 2)
    await expect(page.getByRole('button', { name: 'Next PDF page' })).toBeDisabled()
    await page.getByTestId('pdf-renderer').hover({ position: { x: 30, y: 130 } })
    await page.keyboard.press('c')
    const overlay = page.locator('[data-comment-overlay]')
    await expect(overlay).toContainText('Page 2')
    await overlay.getByPlaceholder('Add your comment...').fill('Clarify this forecast')
    await overlay.getByRole('button', { name: 'Add', exact: true }).click()
    await filePill(page, 'other.pdf').click()
    await expectPage(page, 1)
    await expect(page.getByTestId('file-preview-tray')).not.toContainText('Clarify this forecast')
    await fileTab(page, 'report.pdf').getByTestId('file-tab-select').click()
    await expectPage(page, 2)
    await expect(page.getByTestId('file-preview-tray')).toContainText('Clarify this forecast')
    await page.getByRole('button', { name: 'Hide files panel' }).click()
    await expect(page.getByTestId('pdf-renderer')).not.toBeVisible()
    await filePill(page, 'report.pdf').click()
    await expectPage(page, 2)
    await page.getByRole('button', { name: 'Previous PDF page' }).click()
    await expectPage(page, 1)
  })

  test('responsive rescaling and theme changes keep canvas, text selection and pagination aligned', async ({ page }) => {
    await uploadPdfs(page)
    await filePill(page, 'report.pdf').click()
    await expectPage(page, 1)
    await expectAlignedText(page)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expectAlignedText(page)
    const initialWidth = (await page.getByTestId('pdf-renderer').locator('canvas').boundingBox())!.width
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => (await page.getByTestId('pdf-renderer').locator('canvas').boundingBox())?.width).toBeLessThan(initialWidth - 20)
    await expectAlignedText(page)
    await page.getByRole('button', { name: 'Next PDF page' }).click()
    await expectPage(page, 2)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.getByRole('button', { name: 'Previous PDF page' }).click()
    await expectPage(page, 1)
    await expectAlignedText(page)
  })

  test('a malformed PDF shows an error and does not poison a valid document in another tab', async ({ page, browserName }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await uploadPdfs(page, [
      { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nnot a PDF\n') },
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    ])
    await filePill(page, 'broken.pdf').click()
    await expect(page.getByText('Failed to load PDF', { exact: true })).toBeVisible()
    await expect(page.getByTestId('pdf-pagination')).toHaveCount(0)
    await filePill(page, 'report.pdf').click()
    await expectPage(page, 1)
    await expect(page.getByText('Failed to load PDF', { exact: true })).toHaveCount(0)
    await fileTab(page, 'broken.pdf').getByTestId('file-tab-select').click()
    await expect(page.getByText('Failed to load PDF', { exact: true })).toBeVisible()
    await fileTab(page, 'broken.pdf').getByTestId('file-tab-close').click()
    await expectPage(page, 1)
    await expectAlignedText(page)
    // WebKit also emits this layout notification on 10.4.1 during error/page
    // tab switching. Keep it in the report; every other page error
    // fails, and the pixel/selection comparison above requires layout to settle.
    const layoutNotification = 'ResizeObserver loop completed with undelivered notifications.'
    const isBaselineLayout = (error: string) => browserName === 'webkit' && error === layoutNotification
    const layoutNotifications = errors.filter(isBaselineLayout)
    if (layoutNotifications.length) {
      testInfo.annotations.push({ type: 'browser-layout', description: `${layoutNotification} (${layoutNotifications.length})` })
    }
    expect(errors.filter(error => !isBaselineLayout(error))).toEqual([])
  })

  test('switching away from a pending PDF isolates its completion or cancellation', async ({ page }) => {
    await uploadPdfs(page, [
      { name: 'slow.pdf', mimeType: 'application/pdf', buffer: pdfFixture('Delayed report') },
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    ])
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let requestFinished!: () => void
    const finished = new Promise<void>(resolve => { requestFinished = resolve })
    let originalRequest: Request | undefined
    const onFinished = (request: Request) => { if (request === originalRequest) requestFinished() }
    page.on('requestfinished', onFinished)
    page.on('requestfailed', onFinished)
    let requested = false
    await page.route(/\/api\/.*slow-\d+\.pdf.*$/, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      originalRequest ??= route.request()
      requested = true
      await held
      await route.continue().catch(() => { /* The abandoned document may have cancelled its fetch. */ })
    })
    try {
      await filePill(page, 'slow.pdf').click()
      await expect.poll(() => requested).toBe(true)
      await filePill(page, 'report.pdf').click()
      await expectPage(page, 1)
      await page.getByRole('button', { name: 'Next PDF page' }).click()
      await expectPage(page, 2)
      release()
      await finished
      await expect(fileTab(page, 'report.pdf')).toHaveAttribute('data-active', 'true')
      await expectPage(page, 2)
      await expect(page.getByTestId('pdf-renderer')).not.toContainText('Delayed report')
      await fileTab(page, 'slow.pdf').getByTestId('file-tab-select').click()
      await expect(page.getByTestId('pdf-renderer').getByText('Delayed report', { exact: true })).toBeVisible()
      await expect(page.getByTestId('pdf-pagination')).toContainText('1 / 2')
      await fileTab(page, 'report.pdf').getByTestId('file-tab-select').click()
      await expectPage(page, 2)
    } finally {
      release()
      page.off('requestfinished', onFinished)
      page.off('requestfailed', onFinished)
    }
  })
})
