import { test, expect } from '@playwright/test'
import { NOTIFICATION_TYPES } from '../../src/shared/lib/notifications/notification-filters'

for (const width of [390, 1280]) {
  test(`notification filters remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    const notifications = [
      ...Array.from({ length: 20 }, (_, i) => ({ type: 'session_complete', title: `Completed task ${i + 1}` })),
      { type: 'session_waiting', title: 'Approve the release' },
      { type: 'session_mention', title: 'Morgan mentioned you' },
      { type: 'session_scheduled', title: 'Weekly report started' },
    ].map((row, i) => ({
      ...row, id: `notification-${i}`, sessionId: `session-${i}`, agentSlug: 'release-planner',
      body: 'Release checklist ready for review', isRead: false, readAt: null,
      createdAt: new Date(2026, 10, 5, 10, 30 - i).toISOString(),
    }))
    const readBodies: unknown[] = []
    await page.route('**/api/notifications**', async route => {
      const url = URL.parse(route.request().url())!
      if (url.pathname.endsWith('/stream')) return route.abort()
      if (url.pathname.endsWith('/unread-count')) {
        return route.fulfill({ json: { count: notifications.filter(n => !n.isRead && n.type !== 'session_scheduled').length, mentions: 1, types: Object.fromEntries(NOTIFICATION_TYPES.map(type => [type, {
          total: notifications.filter(n => n.type === type).length,
          unread: notifications.filter(n => n.type === type && !n.isRead).length,
        }])) } })
      }
      if (url.pathname.endsWith('/read-all')) {
        const body = route.request().postDataJSON() as { types: string[] }
        readBodies.push(body)
        for (const n of notifications) if (body.types.includes(n.type)) n.isRead = true
        return route.fulfill({ json: { success: true } })
      }
      const types = url.searchParams.get('types')?.split(',')
      const items = notifications.filter(n => !types || types.includes(n.type))
      return route.fulfill({ json: { items: items.slice(0, Number(url.searchParams.get('limit'))), total: items.length } })
    })
    await page.route('**/api/platform-notifications**', route => route.fulfill({ json:
      route.request().url().includes('/unread-count') ? { count: 0 } : {
        notifications: [{ id: 'announcement', title: 'Product news', body: 'A new release is available',
          kind: 'broadcast', read_at: '2026-11-04T10:00:00Z', created_at: '2026-11-04T09:00:00Z' }],
        total: 1, unread_count: 0, connected: true,
      },
    }))

    await page.goto('/notifications')
    await expect(page.getByRole('tab')).toHaveCount(6)
    const tabs = page.getByRole('tablist', { name: 'Filter notifications' })
    const markRead = page.getByTestId('notifications-mark-all-read')
    const tabBox = (await tabs.boundingBox())!
    const actionBox = (await markRead.boundingBox())!
    expect(tabBox.x + tabBox.width <= actionBox.x || tabBox.y + tabBox.height <= actionBox.y).toBe(true)
    const titleBox = (await page.getByText('Completed task 1', { exact: true }).boundingBox())!
    expect(titleBox.width).toBeGreaterThan(80)

    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(page.getByText('2 / 2')).toBeVisible()
    await page.getByTestId('notifications-filter-completed').click()
    await expect(page).toHaveURL(/filter=completed/)
    await expect(page.getByText('1 / 2')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('notifications-filter-completed')).toHaveAttribute('aria-selected', 'true')

    await markRead.click()
    await expect.poll(() => readBodies).toEqual([{ types: ['session_complete'] }])
    await expect(page.getByTestId('notifications-filter-completed')).toHaveText('Completed')
    await expect(markRead).toBeDisabled()

    await page.goBack()
    await expect(page.getByTestId('notifications-filter-all')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('1 / 2')).toBeVisible()
    await page.getByTestId('notifications-filter-needs-you').click()
    await expect(page.getByText('Approve the release', { exact: true })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Unread', exact: true })).toHaveCount(1)
    await expect(markRead).toBeEnabled()

    // The last tab must be reachable by keyboard even when the strip scrolls.
    await page.getByTestId('notifications-filter-all').focus()
    await page.keyboard.press('End')
    await expect(page.getByTestId('notifications-filter-announcements')).toBeFocused()
    await expect(page).toHaveURL(/filter=announcements/)
    await expect(page.getByText('Product news', { exact: true })).toBeVisible()
  })
}
