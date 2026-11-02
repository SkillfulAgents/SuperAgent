import { test, expect } from '@playwright/test'
import { createAgent, createSession, type TestAgent } from '../helpers/agents'
import type { ApiAgent } from '../../src/shared/lib/types/api'

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
          expect(reads).toEqual([])
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
