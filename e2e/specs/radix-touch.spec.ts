import { test, expect, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'

interface TouchAgent { slug: string; name: string; displaySlug: string }

async function createAgent(request: APIRequestContext, name: string): Promise<TouchAgent> {
  const response = await request.post('/api/agents', { data: { name } })
  expect(response.status()).toBe(201)
  return response.json()
}

async function openSidebar(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Toggle Sidebar' }).tap()
  const sidebar = page.getByRole('dialog', { name: 'Sidebar', exact: true })
  await expect(sidebar).toBeVisible()
  return sidebar
}

/**
 * Chromium provides trusted press/move/release through CDP. Playwright's
 * WebKit touchscreen API only supports a complete tap, so its hold/movement
 * checks exercise the app's real pointer handlers with synthetic events.
 * Subsequent taps use WebKit's actual input backend; do not describe these
 * WebKit hold checks as physical-device gesture or iOS magnifier coverage.
 */
async function finger(page: Page, target: Locator, browserName: string) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  let x = box!.x + Math.min(box!.width / 2, 80)
  let y = box!.y + box!.height / 2
  const cdp: CDPSession | undefined = browserName === 'chromium'
    ? await page.context().newCDPSession(page) : undefined
  const point = () => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 })
  const pointer = () => ({ pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, buttons: 1 })
  return {
    async down() {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point()] })
      else await target.dispatchEvent('pointerdown', pointer())
    },
    async move(deltaY: number) {
      y += deltaY
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point()] })
      else await target.dispatchEvent('pointermove', pointer())
    },
    async up() {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      else {
        await target.dispatchEvent('pointerup', { ...pointer(), buttons: 0 })
      }
    },
    async cancel() {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      else await target.dispatchEvent('pointercancel', { ...pointer(), buttons: 0 })
    },
    async dispose() { await cdp?.detach() },
  }
}

test.describe('Radix mobile interaction boundaries', () => {
  test.beforeEach(async ({ isMobile }, testInfo) => {
    test.skip(!isMobile, 'Runs in the dedicated Radix touch projects')
    testInfo.annotations.push({
      type: 'touch-input',
      description: testInfo.project.name.includes('webkit')
        ? 'Native WebKit taps; synthetic pointer holds/movement because its public touchscreen API has no hold/swipe.'
        : 'Native Chromium touch press/move/release through CDP, and touchscreen taps.',
    })
  })

  test('long press keeps navigation local, resets its submenu, and leaves ordinary taps working', async ({ page, request, browserName }) => {
    const agent = await createAgent(request, `Touch menu ${Date.now()}`)
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    try {
      const sidebar = await openSidebar(page)
      const link = sidebar.getByTestId(`agent-item-${agent.slug}`)
      const trigger = sidebar.locator('[data-sidebar="menu-button"]').filter({ has: page.getByTestId(`agent-item-${agent.slug}`) })
      const gesture = await finger(page, link, browserName)
      try {
        await gesture.down()
        await expect(trigger).toHaveAttribute('data-pressing', '')
        await expect(page.getByTestId('agent-context-menu')).toBeVisible()
        await gesture.up()
        await expect(page).toHaveURL(/\/$/)
        await expect(page.getByTestId('agent-context-menu')).toBeVisible()
        await expect(trigger).not.toHaveAttribute('data-pressing')
      } finally { await gesture.dispose() }

      await page.getByTestId('move-agent-to-folder-trigger').tap()
      await expect(page.getByTestId('move-agent-to-folder-menu')).toBeVisible()
      await expect(page.getByTestId('move-agent-to-new-folder-item')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('agent-context-menu')).not.toBeVisible()
      // Baseline behavior: the custom drawer's document Escape handler also
      // dismisses the drawer. Assert recovery rather than hiding it behind a
      // conditional reopen; this behavior predates the dependency upgrade.
      await expect(sidebar).toHaveAttribute('inert', '')
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
      await page.getByRole('button', { name: 'Toggle Sidebar' }).tap()
      await expect(sidebar).not.toHaveAttribute('inert')

      const second = await finger(page, link, browserName)
      try {
        await second.down()
        await expect(page.getByTestId('agent-context-menu')).toBeVisible()
        await second.up()
        await expect(page.getByTestId('move-agent-to-folder-menu')).not.toBeVisible()
      } finally { await second.dispose() }
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('agent-context-menu')).not.toBeVisible()
      await expect(sidebar).toHaveAttribute('inert', '')
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
      await page.getByRole('button', { name: 'Toggle Sidebar' }).tap()
      await expect(sidebar).not.toHaveAttribute('inert')
      await link.tap()
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.displaySlug}$`))
      await expect(page.getByRole('button', { name: 'Toggle Sidebar' })).toBeVisible()
      expect(pageErrors).toEqual([])
    } finally {
      await request.delete(`/api/agents/${agent.slug}`).catch(() => undefined)
    }
  })

  test('touch movement and cancellation clear the pending long press', async ({ page, request, browserName }) => {
    const agents: TouchAgent[] = []
    try {
      for (let index = 0; index < 18; index++) agents.push(await createAgent(request, `Scroll agent ${index}`))
      const sidebar = await openSidebar(page)
      const list = sidebar.getByTestId('agent-list-scroll')
      await expect.poll(() => list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100)
      const links = sidebar.locator('[data-testid^="agent-item-"]')
      const targetId = await links.nth(5).getAttribute('data-testid')
      expect(targetId).not.toBeNull()
      const target = sidebar.getByTestId(targetId!)
      const trigger = sidebar.locator('[data-sidebar="menu-button"]').filter({ has: page.getByTestId(targetId!) })
      const gesture = await finger(page, target, browserName)
      const beforeScroll = await list.evaluate(el => el.scrollTop)
      try {
        await gesture.down()
        await expect(trigger).toHaveAttribute('data-pressing', '')
        for (let step = 0; step < 6; step++) await gesture.move(-25)
        await gesture.up()
        await expect(trigger).not.toHaveAttribute('data-pressing')
        // Both the app's 400ms timer and Radix's longer hold timer must expire
        // without opening a menu after movement.
        // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- Negative assertion must outlast the 400ms app and 700ms Radix long-press timers.
        await page.waitForTimeout(800)
        await expect(page.getByTestId('agent-context-menu')).not.toBeVisible()
        if (browserName === 'chromium') {
          await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(beforeScroll)
        }
      } finally { await gesture.dispose() }

      const canceled = await finger(page, target, browserName)
      try {
        await canceled.down()
        await expect(trigger).toHaveAttribute('data-pressing', '')
        await canceled.cancel()
        await expect(trigger).not.toHaveAttribute('data-pressing')
        // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- Negative assertion must outlast the 400ms app and 700ms Radix long-press timers.
        await page.waitForTimeout(800)
        await expect(page.getByTestId('agent-context-menu')).not.toBeVisible()
      } finally { await canceled.dispose() }
      await target.tap()
      await expect(page).toHaveURL(/\/agents\//)
    } finally {
      for (const agent of agents) await request.delete(`/api/agents/${agent.slug}`).catch(() => undefined)
    }
  })

  test('a menu in the sidebar hands touch and text editing to its nested rename dialog', async ({ page, request, browserName }) => {
    const agent = await createAgent(request, `Rename by touch ${Date.now()}`)
    try {
      const sidebar = await openSidebar(page)
      const link = sidebar.getByTestId(`agent-item-${agent.slug}`)
      const gesture = await finger(page, link, browserName)
      try {
        await gesture.down()
        await expect(page.getByTestId('agent-context-menu')).toBeVisible()
        await gesture.up()
      } finally { await gesture.dispose() }
      await expect(page).toHaveURL(/\/$/)
      // With native Chromium touch, the release click is retargeted to the
      // drawer backdrop after Radix makes the body pointer-inert. Both old and
      // new dependencies close the drawer underneath the still-usable menu.
      // WebKit's synthetic hold cannot reproduce that native release behavior.
      if (browserName === 'chromium') await expect(sidebar).toHaveAttribute('inert', '')
      else await expect(sidebar).not.toHaveAttribute('inert')
      await page.getByTestId('rename-agent-item').tap()
      const rename = page.getByRole('dialog', { name: 'Rename Agent', exact: true })
      const input = rename.getByLabel('Agent name')
      await expect(rename).toBeVisible()
      await expect(page.getByTestId('agent-context-menu')).not.toBeVisible()
      await input.tap()
      await expect(input).toBeFocused()
      await input.selectText()
      await expect.poll(() => input.evaluate(el => (el as HTMLInputElement).selectionEnd! - (el as HTMLInputElement).selectionStart!)).toBe(agent.name.length)
      await page.keyboard.insertText('Canceled touch edit')
      await expect(input).toHaveValue('Canceled touch edit')
      await rename.getByRole('button', { name: 'Cancel', exact: true }).tap()
      await expect(rename).not.toBeVisible()
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
      if (browserName === 'chromium') {
        await expect(sidebar).toHaveAttribute('inert', '')
        await page.getByRole('button', { name: 'Toggle Sidebar' }).tap()
      }
      await expect(sidebar).not.toHaveAttribute('inert')
      await expect(link).toContainText(agent.name)
      const response = await request.get(`/api/agents/${agent.slug}`)
      expect(response.ok()).toBe(true)
      expect((await response.json() as TouchAgent).name).toBe(agent.name)
      await link.tap()
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.displaySlug}$`))
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
    } finally {
      await request.delete(`/api/agents/${agent.slug}`).catch(() => undefined)
    }
  })


  test('a nested timezone picker accepts touch input, scroll, selection, and layered dismissal', async ({ page, request, browserName }) => {
    test.setTimeout(60_000)
    const agent = await createAgent(request, `Touch schedule ${Date.now()}`)
    let taskId: string | undefined
    try {
      await page.goto(`/agents/${agent.slug}`)
      await new AppPage(page).waitForAgentsLoaded()
      const session = new SessionPage(page)
      await session.sendMessage('schedule task for daily issues')
      await session.waitForResponse(15_000)
      await session.waitForInputEnabled()
      await expect.poll(async () => {
        const response = await request.get(`/api/agents/${agent.slug}/scheduled-tasks`)
        expect(response.ok()).toBe(true)
        taskId = (await response.json() as Array<{ id: string; name: string }>).find(task => task.name === 'Daily Issue Summary')?.id
        return Boolean(taskId)
      }).toBe(true)
      await page.route(`**/api/scheduled-tasks/${taskId}/describe-schedule`, route =>
        route.fulfill({ json: { description: 'Every weekday at 9 AM' } }))
      await page.goto(`/agents/${agent.slug}/tasks/${taskId}`)
      const openEdit = async () => {
        await page.getByRole('button', { name: 'Cron settings' }).tap()
        await page.getByRole('button', { name: 'Edit Schedule', exact: true }).tap()
      }
      await openEdit()
      const dialog = page.getByRole('dialog', { name: 'Edit Schedule', exact: true })
      const trigger = dialog.getByRole('combobox', { name: 'Select timezone' })
      await trigger.tap()
      const search = page.getByPlaceholder('Search timezone...')
      await expect(search).toBeFocused()
      await search.tap()
      await page.keyboard.insertText('London')
      await search.selectText()
      await expect.poll(() => search.evaluate(el => (el as HTMLInputElement).selectionEnd! - (el as HTMLInputElement).selectionStart!)).toBe(6)
      await page.keyboard.insertText('Chatham')
      await expect(search).toHaveValue('Chatham')
      await expect(page.getByRole('button', { name: /Pacific\/Chatham/ })).toBeVisible()
      await search.fill('')
      const scroller = page.getByTestId('timezone-options')
      await expect.poll(() => scroller.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      if (browserName === 'chromium') {
        const swipe = await finger(page, scroller, browserName)
        try {
          await swipe.down()
          for (let step = 0; step < 3; step++) await swipe.move(-25)
          await swipe.up()
          await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        } finally { await swipe.dispose() }
      }
      await page.keyboard.press('Escape')
      await expect(search).not.toBeVisible()
      await expect(dialog).toBeVisible()
      await expect(trigger).toBeFocused()
      await trigger.tap()
      await expect(search).toBeFocused()
      await search.fill('Chatham')
      await page.getByRole('button', { name: /Pacific\/Chatham/ }).tap()
      await expect(search).not.toBeVisible()
      await expect(trigger).toBeFocused()
      await expect(trigger).toContainText('Pacific/Chatham')
      await dialog.getByRole('button', { name: 'Save Schedule', exact: true }).tap()
      await expect(dialog).not.toBeVisible()
      await expect.poll(async () => {
        const response = await request.get(`/api/scheduled-tasks/${taskId}`)
        expect(response.ok()).toBe(true)
        return (await response.json() as { timezone: string }).timezone
      }).toBe('Pacific/Chatham')
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
      await openEdit()
      await expect(trigger).toContainText('Pacific/Chatham')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap()
      await expect(dialog).not.toBeVisible()
      await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
    } finally {
      if (taskId) await request.delete(`/api/scheduled-tasks/${taskId}`).catch(() => undefined)
      await request.delete(`/api/agents/${agent.slug}`).catch(() => undefined)
    }
  })
})
