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

    await showAll.click()
    await expect(rows).toHaveCount(7)
    expect(listReads.some((search) => !new URLSearchParams(search).has('limit'))).toBe(true)
  })

  test('"Show less" waits under the sidebar list while the open list runs past its foot', async ({ page, request }, testInfo) => {
    test.setTimeout(90_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Pinned Toggle'))
    for (let i = 0; i < 7; i += 1) {
      const session = await createSession(request, agent, `Message ${i} ${uniqueName(testInfo, 'pinned')}`)
      await waitForSessionIdle(request, agent, session)
    }
    await page.setViewportSize({ width: 1280, height: 320 })
    await page.goto(`/agents/${agent.slug}`)
    await page.getByRole('button', { name: 'Show all (7)', exact: true }).click()

    const scroller = page.locator('[data-testid="agent-list-scroll"]')
    const pinned = page.locator('[data-show-less-slot] button')
    const scrollListToTop = () => page.locator('[data-testid^="session-item-"]').first()
      .evaluate((el) => el.closest('ul')?.scrollIntoView({ block: 'start' }))
    // Agents sort newest first, so other tests' agents can sit above this one.
    await scrollListToTop()
    await expect(pinned).toHaveText('Show less')
    await expect(pinned).toBeInViewport()
    await expect(scroller).toHaveCSS('mask-image', /linear-gradient/)
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(pinned).toHaveCount(0)
    await expect(scroller).toHaveCSS('mask-image', 'none')
    const inList = page.getByRole('button', { name: 'Show less', exact: true })
    await expect(inList.locator('xpath=ancestor::li[1]')).toHaveCSS('opacity', '1')

    // Collapsing from the pinned copy returns the list to five rows.
    await scrollListToTop()
    await pinned.click()
    await expect(page.getByRole('button', { name: 'Show all (7)', exact: true })).toBeVisible()
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
