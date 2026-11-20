import { test, expect } from '@playwright/test'
import { createAgent, createSession, uniqueName, waitForSessionIdle } from '../helpers/agents'

/**
 * A session page shows five of the agent's sessions (its sidebar row) and two
 * activity flags (the header), so it must not read the agent's whole session
 * list: that answers every session and, in auth mode, looks up the
 * participants of each. The whole list is read when "Show all" asks for it.
 */
test.describe('Session list requests', () => {
  test('a session page reads only bounded session lists until "Show all"', async ({ page, request }, testInfo) => {
    test.setTimeout(90_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Bounded Lists'))
    const sessions = []
    for (let i = 0; i < 7; i += 1) {
      const session = await createSession(request, agent, `Message ${i} ${uniqueName(testInfo, 'bounded')}`)
      await waitForSessionIdle(request, agent, session)
      sessions.push(session)
    }
    const opened = sessions[sessions.length - 1]

    // GET /api/agents/<agent>/sessions[?query]: the list route, not a session's own.
    const listPath = `/api/agents/${agent.slug}/sessions`
    const listReads: string[] = []
    page.on('request', (req) => {
      if (req.method() !== 'GET') return
      const [path, search = ''] = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')
      if (path === listPath) listReads.push(search)
    })

    await page.goto(`/agents/${agent.slug}/sessions/${opened.id}`)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    // The row shows the five newest, the open one among them, and the count.
    const rows = page.locator('[data-testid^="session-item-"]')
    await expect(rows).toHaveCount(5)
    await expect(page.locator(`[data-testid="session-item-${opened.id}"]`)).toBeVisible()
    const showAll = page.getByRole('button', { name: 'Show all (7)', exact: true })
    await expect(showAll).toBeVisible()

    expect(listReads.length).toBeGreaterThan(0)
    expect(listReads.filter((search) => !new URLSearchParams(search).has('limit'))).toEqual([])

    await showAll.press('Enter')
    await expect(rows).toHaveCount(7)
    expect(listReads.some((search) => !new URLSearchParams(search).has('limit'))).toBe(true)
    const showLess = page.getByRole('button', { name: 'Show less', exact: true })
    await expect(showLess).toBeFocused()
    const overlay = page.locator('[data-sidebar="menu-sub"] > li').filter({ has: showLess })
    await expect(overlay).toHaveCSS('position', 'sticky')
    expect(await overlay.evaluate(row => getComputedStyle(row, '::before').backgroundImage)).toContain('linear-gradient')
    await page.keyboard.press('Space')
    await expect(rows).toHaveCount(5)
  })

  test('the agent home reads the full list for the row, and leaving it keeps the newest rows', async ({ page, request }, testInfo) => {
    test.setTimeout(90_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Live Full List'))
    const first = await createSession(request, agent, `First ${uniqueName(testInfo, 'live')}`)
    await waitForSessionIdle(request, agent, first)

    const listPath = `/api/agents/${agent.slug}/sessions`
    const isRecentRead = (href: string) => {
      const [path, search = ''] = href.replace(/^https?:\/\/[^/]+/, '').split('?')
      return path === listPath && new URLSearchParams(search).get('with_total') === 'true'
    }
    const recentReads: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && isRecentRead(req.url())) recentReads.push(req.url())
    })

    // The home lists every session, so the row's slice follows the home's reads.
    await page.goto(`/agents/${agent.slug}`)
    const sidebarRow = (id: string) => page.locator(`[data-testid="session-item-${id}"]`)
    await expect(sidebarRow(first.id)).toBeVisible()
    const readsOnArrival = recentReads.length

    // A session started elsewhere reaches the row through the home's read.
    const fresh = await createSession(request, agent, `Fresh ${uniqueName(testInfo, 'live')}`)
    await expect(sidebarRow(fresh.id)).toBeVisible()
    await waitForSessionIdle(request, agent, fresh)
    await expect(sidebarRow(fresh.id)).toBeVisible()
    expect(recentReads.length).toBe(readsOnArrival)

    // Leave the home with the slice's own read held: the row keeps the session
    // the home's read brought in, before and after that read lands.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let heldReads = 0
    await page.route((url) => isRecentRead(url.href), async (route) => {
      heldReads += 1
      await held
      await route.continue()
    })
    await sidebarRow(first.id).click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()
    await expect(sidebarRow(fresh.id)).toBeVisible()
    await expect(sidebarRow(first.id)).toBeVisible()
    // The slice may still be fresh from the home's last read, and then reads nothing.
    const landed = heldReads > 0 ? page.waitForResponse((res) => isRecentRead(res.url())) : Promise.resolve(null)
    release()
    await landed
    await expect(sidebarRow(fresh.id)).toBeVisible()
  })
})
