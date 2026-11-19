import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { createAgent, uniqueName } from '../helpers/agents'

for (const sendWith of ['Enter', 'button'] as const) {
  test(`first send with ${sendWith} adopts the session in place`, async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'New Session'))
    const app = new AppPage(page)
    await app.goto()
    await app.waitForAgentsLoaded()

    const invalidSessionRequests: string[] = []
    page.on('request', (req) => {
      if (/\/sessions\/(new|null|undefined)(?:\/|\?|$)/.test(req.url()) && req.url().includes('/api/')) {
        invalidSessionRequests.push(req.url())
      }
    })
    await page.getByTestId(`agent-item-${agent.slug}`).hover()
    const startRequest = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith(`/agents/${agent.slug}/start`))
    await page.getByTestId(`agent-new-session-${agent.slug}`).click()
    await startRequest
    await expect(page).toHaveURL(/\/sessions\/new$/)
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    expect(await (await request.get(`/api/agents/${agent.slug}/sessions`)).json()).toEqual([])

    // Hold creation so the sending state is observable even on the fast mock.
    let releaseCreate!: () => void
    const allowCreate = new Promise<void>((resolve) => { releaseCreate = resolve })
    let creationStarted!: () => void
    const creating = new Promise<void>((resolve) => { creationStarted = resolve })
    await page.route('**/api/agents/*/sessions', async (route) => {
      if (route.request().method() === 'POST') {
        creationStarted()
        await allowCreate
      }
      await route.continue()
    })

    await input.fill('Hello from the shared session composer')
    const editor = await input.elementHandle()
    const footer = await page.locator('[data-composer-footer]').elementHandle()
    const before = await page.locator('[data-composer-footer]').boundingBox()
    // Observe removal, even if React were to reinsert the same element later.
    await editor!.evaluate((element) => {
      element.setAttribute('data-continuity', 'kept')
      const observer = new MutationObserver((records) => {
        if (records.some((record) => [...record.removedNodes].some((removed) => removed === element || removed.contains(element)))) {
          element.setAttribute('data-continuity', 'removed')
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    if (sendWith === 'Enter') await input.press('Enter')
    else await page.getByTestId('send-button').click()
    await creating
    await expect(input).toHaveText('Hello from the shared session composer')
    releaseCreate()

    await expect(page).toHaveURL(/\/sessions\/(?!new$)[^/]+$/)
    await expect(input).toHaveText('')
    expect(await editor!.evaluate((element) => element === document.querySelector('[data-testid="message-input"]'))).toBe(true)
    expect(await editor!.getAttribute('data-continuity')).toBe('kept')
    expect(await footer!.evaluate((element) => element === document.querySelector('[data-composer-footer]'))).toBe(true)
    await expect(input).toBeFocused()
    const after = await page.locator('[data-composer-footer]').boundingBox()
    expect(after!.x).toBeCloseTo(before!.x, 0)
    expect(after!.width).toBeCloseTo(before!.width, 0)
    expect(after!.y + after!.height).toBeCloseTo(before!.y + before!.height, 0)
    await expect(page.getByText('Hello from the shared session composer', { exact: true }).first()).toBeVisible()
    expect(await (await request.get(`/api/agents/${agent.slug}/sessions`)).json()).toHaveLength(1)
    expect(invalidSessionRequests).toEqual([])

    // The retained composer now writes to the real session's draft slot.
    await input.fill('Next message draft')
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await page.goForward()
    await expect(page.getByTestId('message-input')).toHaveText('Next message draft')
    await page.getByTestId(`agent-item-${agent.slug}`).hover()
    await page.getByTestId(`agent-new-session-${agent.slug}`).click()
    await expect(page).toHaveURL(/\/sessions\/new$/)
    await expect(page.getByTestId('message-input')).toHaveText('')
  })
}
