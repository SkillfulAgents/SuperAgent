import { test, expect } from '@playwright/test'
import { createAgent, createSession, type TestAgent } from '../helpers/agents'
import type { ApiAgent, ApiNotification } from '../../src/shared/lib/types/api'

// Bulk reads share server state; don't overlap this file's fixtures.
test.describe.configure({ mode: 'serial' })

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} notification reads`, () => {
    test.use({ colorScheme, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, contextOptions: { reducedMotion: 'reduce' } })

    for (const succeeds of [true, false]) {
      test(`clears previews before the write responds and ${succeeds ? 'confirms without refetching' : 'restores them on failure'}`, async ({ page, request }, testInfo) => {
        test.setTimeout(60_000)
        const agents: TestAgent[] = []
        let release!: () => void
        const pending = new Promise<void>(resolve => { release = resolve })
        try {
          for (const name of ['Travel Planner', 'Weekly Reports']) {
            const agent = await createAgent(request, name)
            agents.push(agent)
            const session = await createSession(request, agent, 'Summarize the next steps for this week')
            if (name === 'Weekly Reports') {
              const marked = await request.post(`/api/agents/${agent.slug}/sessions/${session.id}/unread`)
              expect(marked.ok()).toBeTruthy()
            }
          }
          await expect.poll(async () => {
            const data = await (await request.get('/api/agents')).json() as ApiAgent[]
            return agents.every(agent => data.some(row => row.slug === agent.slug && row.notificationPreview && !row.hasActiveSessions))
          }, { timeout: 30_000 }).toBe(true)

          // Other specs may run agents on this mock host. Their SSE events are
          // unrelated to this read and would legitimately cause extra GETs.
          await page.route('**/api/notifications/stream', route => route.abort())
          await page.route('**/api/notifications/read-all', async route => {
            await pending
            if (succeeds) await route.fulfill({ response: await route.fetch() })
            else await route.fulfill({ status: 503, json: { error: 'Test write failure' } })
          })
          await page.goto('/notifications')
          const previews = agents.map(agent => page.getByTestId(`agent-notification-preview-${agent.slug}`))
          for (const preview of previews) await expect(preview).toBeVisible()
          const ordinaryBadge = page.getByTestId(`agent-avatar-badge-${agents[0].slug}`)
          const reminderBadge = page.getByTestId(`agent-avatar-badge-${agents[1].slug}`)
          await expect(ordinaryBadge).toHaveAccessibleName('unread notifications')
          await expect(reminderBadge).toHaveAccessibleName('unread notifications')
          const markAll = page.getByTestId('notifications-mark-all-read')
          await expect(markAll).toBeEnabled()
          await page.evaluate(() => document.fonts.ready)
          if (succeeds) await page.screenshot({ path: testInfo.outputPath(`before-${colorScheme}.png`) })

          const reads: string[] = []
          page.on('request', req => {
            if (req.method() === 'GET' && /^\/api\/(agents|notifications(?:\/unread-count)?)$/.test(new URL(req.url()).pathname)) reads.push(req.url())
          })
          const write = page.waitForResponse(response => response.url().endsWith('/api/notifications/read-all') && response.request().method() === 'POST')
          await markAll.click()
          // The POST is still held at this point: these are optimistic changes.
          for (const preview of previews) await expect(preview).toHaveCount(0)
          await expect(ordinaryBadge).toHaveCount(0)
          await expect(reminderBadge).toHaveAccessibleName('unread notifications')
          await expect(page.getByRole('status', { name: 'Unread', exact: true })).toHaveCount(0)
          if (succeeds) await page.screenshot({ path: testInfo.outputPath(`pending-${colorScheme}.png`) })

          release()
          await write
          if (succeeds) {
            // Let the response and React's effects settle before inspecting requests.
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
            for (const preview of previews) await expect(preview).toHaveCount(0)
            await expect(ordinaryBadge).toHaveCount(0)
            await expect(reminderBadge).toHaveAccessibleName('unread notifications')
          } else {
            for (const preview of previews) await expect(preview).toBeVisible()
            await expect(ordinaryBadge).toHaveAccessibleName('unread notifications')
            await expect(markAll).toBeEnabled()
          }
          if (succeeds) expect(reads).toEqual([])
          else await expect.poll(() => reads.some(url => url.endsWith('/api/notifications/unread-count'))).toBe(true)
        } finally {
          release()
          await page.unrouteAll({ behavior: 'wait' })
          await page.close()
          for (const agent of agents) await request.delete(`/api/agents/${agent.slug}`)
        }
      })
    }
  })
}

test('notification reads and deletions reach another open window over SSE', async ({ page, context, request }) => {
  test.setTimeout(60_000)
  const agent = await createAgent(request, 'Notification Sync')
  const other = await context.newPage()
  try {
    const session = await createSession(request, agent, 'Summarize this week’s next steps')
    let notification: ApiNotification | undefined
    await expect.poll(async () => {
      const result = await (await request.get('/api/notifications?limit=100')).json() as { items: ApiNotification[] }
      notification = result.items.find(row => row.sessionId === session.id)
      return Boolean(notification)
    }, { timeout: 30_000 }).toBe(true)
    await page.goto('/notifications')
    await other.goto('/notifications')
    const row = (window: typeof page) => window.getByTestId('notification-row').filter({ has: window.locator(`a[href$="/sessions/${session.id}"]`) })
    for (const window of [page, other]) {
      await expect(row(window).getByTestId('notification-mark-read')).toHaveCount(1)
    }
    await row(page).getByTestId('notification-mark-read').dispatchEvent('click')
    // Five seconds is below both notification polling intervals: this must
    // arrive through the live change feed, without navigating or refocusing.
    await expect(row(other).getByTestId('notification-mark-read')).toHaveCount(0, { timeout: 5_000 })
    await expect(other.getByTestId(`agent-notification-preview-${agent.slug}`)).toHaveCount(0)
    expect((await request.delete(`/api/notifications/${notification!.id}`)).status()).toBe(204)
    await expect(row(other)).toHaveCount(0, { timeout: 5_000 })
    await expect(row(page)).toHaveCount(0, { timeout: 5_000 })
  } finally {
    await other.close()
    await page.close()
    await request.delete(`/api/agents/${agent.slug}`)
  }
})
