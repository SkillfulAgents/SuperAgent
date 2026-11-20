import { chromium, expect, test } from '@playwright/test'
import { createAgent, createSession, uniqueName, waitForSessionIdle } from '../helpers/agents'

test('Show less takes one row below the desktop scroller until the last session fits', async ({ playwright }, testInfo) => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.E2E_ELECTRON_DEBUG_PORT ?? '47993'}`)
  try {
    const mainWindow = () => browser.contexts()[0].pages().find(page => /^https?:\/\/[^/]+\/(?:index\.html)?(?:#|$)/.test(page.url()))
    await expect.poll(() => !!mainWindow()).toBe(true)
    const page = mainWindow()!
    await page.setViewportSize({ width: 1280, height: 320 })
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 60_000 })
    const api = await playwright.request.newContext({ baseURL: await page.evaluate(() => window.electronAPI!.getApiUrl()) })
    const agent = await createAgent(api, uniqueName(testInfo, 'Desktop session list'))
    for (let i = 0; i < 12; i++) {
      const session = await createSession(api, agent, `Session ${i}`)
      await waitForSessionIdle(api, agent, session)
    }
    await api.dispose()
    await page.goto(new URL(`/#/agents/${agent.slug}`, page.url()).href)
    await page.reload()

    const showAll = page.getByRole('button', { name: 'Show all (12)', exact: true })
    await showAll.press('Enter')
    const showLess = page.getByRole('button', { name: 'Show less', exact: true })
    const rows = page.locator('[data-testid^="session-item-"]')
    await expect(rows).toHaveCount(12)
    await rows.first().evaluate(row => row.scrollIntoView({ block: 'start' }))
    const scroller = page.getByTestId('agent-list-scroll')
    const footer = page.locator('[data-sidebar="footer"]')
    await expect.poll(async () => {
      const [list, button, foot] = await Promise.all([scroller.boundingBox(), showLess.boundingBox(), footer.boundingBox()])
      return list && button && foot && list.y + list.height === button.y && button.y + button.height === foot.y
    }).toBe(true)
    await expect(showLess).toBeFocused()

    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect.poll(async () => {
      const [list, foot] = await Promise.all([scroller.boundingBox(), footer.boundingBox()])
      return list && foot && list.y + list.height === foot.y
    }).toBe(true)
    await expect(showLess).toBeInViewport({ ratio: 1 })
    await expect(showLess).toBeFocused()
    await page.keyboard.press('Space')
    await expect(rows).toHaveCount(5)
  } finally {
    await browser.close()
  }
})
