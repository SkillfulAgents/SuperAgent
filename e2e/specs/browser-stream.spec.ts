import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { isControlReachable, mockBrowserStream } from '../helpers/browser-stream'

test.describe('Browser Streaming', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string
  let pageErrors: string[]

  test.beforeEach(async ({ page }, testInfo) => {
    pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `Browser Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  test('browser preview shows live screencast from host browser', async ({ page }) => {
    // Send "browse" message to trigger BrowserScenario.
    // Uses a data: URL so the test doesn't depend on network access.
    await sessionPage.sendMessage(
      'browse data:text/html,<h1 style="background:blue;color:white;padding:50px">Browser E2E Test</h1>',
    )

    // Wait for BrowserDrawerPanel to appear.
    // The BrowserScenario emits browser_active:true via SSE → frontend shows the drawer.
    const browserPreview = page.locator('[data-testid="browser-drawer-panel"]')
    await expect(browserPreview).toBeVisible({ timeout: 30000 })

    // Wait for canvas to appear (preview auto-expands when browserActive becomes true)
    const canvas = page.locator('[data-testid="browser-canvas"]')
    await expect(canvas).toBeVisible({ timeout: 10000 })

    // Wait for canvas to actually have rendered pixel content.
    // Canvas defaults to 300x150 so a dimension check alone is not enough —
    // we need to verify that drawImage has been called with a real frame.
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-testid="browser-canvas"]') as HTMLCanvasElement
        if (!c) return false
        const ctx = c.getContext('2d')
        if (!ctx) return false
        const imageData = ctx.getImageData(0, 0, c.width, c.height)
        // Check that at least some non-alpha pixels are non-zero (i.e. a frame was drawn)
        return imageData.data.some((v, i) => i % 4 !== 3 && v !== 0)
      },
      { timeout: 20000 },
    )
  })

  test('keeps the browser controls reachable for a tall page in a short drawer', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 600 })
    await mockBrowserStream(page, 600, 800)
    await sessionPage.sendMessage('browse data:text/html,<h1>Tall page</h1>')
    await expect(page.getByTestId('browser-canvas')).toHaveAttribute('height', '800')

    const rail = page.getByTestId('browser-tray-rail')
    await expect.poll(() => rail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    for (const testId of ['browser-tray-stop', 'browser-tray-fullscreen']) {
      await expect.poll(() => isControlReachable(page.getByTestId(testId))).toBe(true)
    }
    await page.getByTestId('browser-tray-stop').click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
  })

  test('fits a portrait page and its controls in full screen as the window shrinks', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 600 })
    await mockBrowserStream(page, 600, 800)
    await sessionPage.sendMessage('browse data:text/html,<h1>Portrait page</h1>')
    await expect(page.getByTestId('browser-canvas')).toHaveAttribute('height', '800')
    await page.getByTestId('browser-tray-fullscreen').click()
    await expect(page.getByTestId('tray-drawer')).toHaveAttribute('data-fullscreen')
    await expect(page.getByTestId('browser-activity-region')).toBeHidden()

    for (const height of [600, 360]) {
      await page.setViewportSize({ width: 1200, height })
      await expect
        .poll(() =>
          page.getByTestId('browser-tray-card').evaluate((card) => {
            const rail = card.parentElement!.getBoundingClientRect()
            const rect = card.getBoundingClientRect()
            return rect.top >= rail.top && rect.bottom <= rail.bottom && rect.width > 100
          }),
        )
        .toBe(true)
      for (const testId of ['browser-tray-stop', 'browser-tray-fullscreen']) {
        await expect.poll(() => isControlReachable(page.getByTestId(testId))).toBe(true)
      }
    }
    await page.getByTestId('browser-tray-fullscreen').click()
    await expect(page.getByTestId('tray-drawer')).not.toHaveAttribute('data-fullscreen')
    await expect(page.getByTestId('browser-activity-region')).toBeVisible()
  })

  test('gives Escape to the focused remote page or local dialog before full screen', async ({ page }) => {
    const stream = await mockBrowserStream(page, 800, 450)
    await sessionPage.sendMessage('browse data:text/html,<h1>Keyboard ownership</h1>')
    await expect(page.getByTestId('browser-canvas')).toHaveAttribute('width', '800')
    await page.getByTestId('browser-tray-fullscreen').click()
    await expect(page.getByTestId('tray-drawer')).toHaveAttribute('data-fullscreen')
    const remoteEscapes = () =>
      stream.messages
        .map((message) => {
          try {
            return JSON.parse(message)
          } catch {
            throw new Error('Expected valid JSON from the browser stream')
          }
        })
        .filter((message) => message.type === 'input_press' && message.key === 'Escape')

    await page.getByTestId('browser-canvas').focus()
    await page.keyboard.press('Escape')
    await expect.poll(() => remoteEscapes().length).toBe(1)
    await expect(page.getByTestId('tray-drawer')).toHaveAttribute('data-fullscreen')

    await page.getByTestId('browser-tray-stop').click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await expect(page.getByTestId('tray-drawer')).toHaveAttribute('data-fullscreen')

    // Move out of controls whose focus opens a tooltip (another Escape owner).
    await page.getByTestId('browser-tray-url').click()
    await expect(page.getByRole('tooltip')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tray-drawer')).not.toHaveAttribute('data-fullscreen')
    expect(remoteEscapes()).toHaveLength(1)
  })
})
