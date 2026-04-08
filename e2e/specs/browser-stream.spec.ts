import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'


test.describe('Browser Streaming', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `Browser Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('browser preview shows live screencast from host browser', async ({ page }) => {
    // Skip if E2E_CHROMIUM_PATH is not set (no browser available)
    // The dev server logs this, but we can also check by sending the message
    // and seeing if the scenario falls back to the default text response.

    // Capture page errors for debugging
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

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

    // Verify no page errors occurred during the flow
    expect(pageErrors).toEqual([])
  })
})
