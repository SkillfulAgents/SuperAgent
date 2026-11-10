import { test, expect, type Locator } from '@playwright/test'
import { z } from 'zod'
import { createAgent, createSession, uniqueName, type TestAgent } from '../helpers/agents'

// Visibility alone does not catch an icon whose last pixels are cut off.
// Check the badge's painted box against every ancestor that clips overflow.
async function expectBadgeUnclipped(badge: Locator, row: Locator) {
  // Scrolling the badge itself can pan an overflow-hidden wrapper and mask the bug.
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.scrollIntoViewIfNeeded()
  await expect(badge).toBeVisible()
  expect(await badge.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const clipping: string[] = []
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      const clip = ancestor.getBoundingClientRect()
      const clipsX = style.overflowX !== 'visible' && (bounds.left < clip.left - 0.5 || bounds.right > clip.right + 0.5)
      const clipsY = style.overflowY !== 'visible' && (bounds.top < clip.top - 0.5 || bounds.bottom > clip.bottom + 0.5)
      if (clipsX || clipsY) clipping.push(`${ancestor.tagName}: ${clipsX ? 'horizontal' : ''} ${clipsY ? 'vertical' : ''}`)
    }
    return clipping
  })).toEqual([])
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} sidebar avatar badges`, () => {
    test.use({ colorScheme, contextOptions: { reducedMotion: 'reduce' } })

    test('badges clear their wrappers without covering text or changing row controls', async ({ page, request }, testInfo) => {
      test.setTimeout(60_000)
      const agents: (TestAgent & { kind: 'mention' | 'unread' | 'awaiting'; expandable: boolean; sessionId?: string })[] = []
      try {
        for (const kind of ['mention', 'unread', 'awaiting'] as const) {
          for (const expandable of [false, true]) {
            const agent = await createAgent(request, uniqueName(testInfo, `${kind} ${expandable ? 'with sessions' : 'empty'} with a long agent name`))
            const session = expandable ? await createSession(request, agent, 'A session for the expand control') : undefined
            agents.push({ ...agent, kind, expandable, sessionId: session?.id })
          }
        }
        const wireAgents = z.array(z.object({ slug: z.string() }).passthrough())
        await page.route(/\/api\/agents(?:\?.*)?$/, async route => {
          const response = await route.fetch()
          const body = wireAgents.parse(await response.json())
          await route.fulfill({ response, json: body.map(agent => {
            const fixture = agents.find(candidate => candidate.slug === agent.slug)
            return fixture ? {
              ...agent,
              status: 'running',
              hasActiveSessions: false,
              hasSessionsAwaitingInput: fixture.kind === 'awaiting',
              hasUnreadNotifications: fixture.kind !== 'awaiting',
              hasUnreadMention: fixture.kind === 'mention',
              avatar: { color: 'tonal-blue', shape: 'diamond' },
            } : agent
          }) })
        })

        await page.goto('/')
        const mobile = (page.viewportSize()?.width ?? 1280) < 768
        if (mobile) await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()

        for (const agent of agents) {
          const link = page.getByTestId(`agent-item-${agent.slug}`)
          const row = page.locator('[data-sidebar="menu-button"]').filter({ has: link })
          const badge = page.getByTestId(`agent-avatar-badge-${agent.slug}`)
          await expectBadgeUnclipped(badge, row)
          await expect(badge).toHaveAccessibleName(agent.kind === 'mention' ? 'mentioned you' : agent.kind === 'unread' ? 'unread notifications' : 'needs input')
          const name = link.getByText(agent.name, { exact: true })
          await expect(name).toHaveCSS('text-overflow', 'ellipsis')
          const badgeBounds = (await badge.boundingBox())!
          const nameBounds = (await name.boundingBox())!
          const rowBounds = (await row.boundingBox())!
          expect(badgeBounds.x + badgeBounds.width).toBeLessThan(nameBounds.x)
          expect(badgeBounds.y + badgeBounds.height).toBeLessThanOrEqual(rowBounds.y + rowBounds.height)
          expect(rowBounds.height).toBe(44)
        }

        const expandable = agents.find(agent => agent.expandable && agent.kind === 'mention')!
        const row = page.locator('[data-sidebar="menu-button"]').filter({ has: page.getByTestId(`agent-item-${expandable.slug}`) })
        const toggle = row.getByRole('button', { name: 'Expand', exact: true })
        if (!mobile) {
          await toggle.hover()
          await expect(page.getByTestId(`agent-avatar-badge-${expandable.slug}`)).toHaveCSS('opacity', '0')
          await page.mouse.move(700, 100)
          await expect(page.getByTestId(`agent-avatar-badge-${expandable.slug}`)).toHaveCSS('opacity', '1')
          await page.keyboard.press('Tab')
          await toggle.focus()
          await expect(page.getByTestId(`agent-avatar-badge-${expandable.slug}`)).toHaveCSS('opacity', '0')
        }
        await toggle.click()
        await expect(row.getByRole('button', { name: 'Collapse', exact: true })).toHaveAttribute('aria-expanded', 'true')
        await expect(page.getByTestId(`session-item-${expandable.sessionId}`)).toBeVisible()
        await expect(page.getByTestId(`agent-avatar-badge-${expandable.slug}`)).toHaveCount(0)

        // The overhanging corner stays inside the row's navigation target.
        const empty = agents.find(agent => !agent.expandable && agent.kind === 'mention')!
        const badge = page.getByTestId(`agent-avatar-badge-${empty.slug}`)
        await page.locator('[data-sidebar="menu-button"]').filter({ has: page.getByTestId(`agent-item-${empty.slug}`) }).scrollIntoViewIfNeeded()
        const bounds = (await badge.boundingBox())!
        if (testInfo.project.use.hasTouch) await page.touchscreen.tap(bounds.x + bounds.width - 1, bounds.y + bounds.height - 1)
        else await page.mouse.click(bounds.x + bounds.width - 1, bounds.y + bounds.height - 1)
        await expect(page).toHaveURL(new RegExp(`/agents/[^/]*${empty.slug}$`))
      } finally {
        if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' })
        for (const agent of agents) await request.delete(`/api/agents/${agent.slug}`)
      }
    })
  })
}
