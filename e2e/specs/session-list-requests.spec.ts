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
})
