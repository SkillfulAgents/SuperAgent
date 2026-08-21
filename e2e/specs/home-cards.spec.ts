import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createAgent, uniqueName } from '../helpers/agents'

/**
 * Drag a grid tile down by `dy` px and only return once the grid has visibly
 * taken the gesture (the actively-dragged tile carries scale-[1.02]).
 *
 * A plain down/move/up sequence engages flakily here for two reasons:
 * - Radix menus set pointer-events:none on <body> while open and restore it
 *   asynchronously after close — a pointerdown in that window hits nothing.
 * - Tiles animate position (transition-[left,top] duration-200), so a
 *   boundingBox taken mid-reflow points at where the card used to be.
 * Both produce a silent no-op drag; without retry the spec then hangs on a
 * layout PUT that never happens. Re-grab coordinates and retry instead.
 */
async function dragTile(page: Page, tile: Locator, dy: number): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    await tile.scrollIntoViewIfNeeded()
    const box = await tile.boundingBox()
    expect(box).not.toBeNull()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy + dy, { steps: 8 })
    try {
      await expect(tile).toHaveClass(/scale-\[1\.02\]/, { timeout: 2_000 })
      await page.mouse.up()
      return
    } catch (error) {
      lastError = error
      await page.mouse.up()
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('dragTile: tile never entered the dragging state')
}

function seedDashboard(agentSlug: string) {
  const dataDir = process.env.SUPERAGENT_DATA_DIR
  if (!dataDir) throw new Error('SUPERAGENT_DATA_DIR is required for dashboard seeding')
  const dashboardDir = path.join(dataDir, 'agents', agentSlug, 'workspace', 'artifacts', 'arrange-dashboard')
  fs.mkdirSync(dashboardDir, { recursive: true })
  fs.writeFileSync(
    path.join(dashboardDir, 'package.json'),
    JSON.stringify({ name: 'Arrange Dashboard', version: '1.0.0' })
  )
}

test.describe('home card arrangement', () => {
  test('desktop Arrange persists independently from the mobile layout', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(60_000)
    const agent = await createAgent(request, uniqueName(testInfo, 'Home Arrange'))
    seedDashboard(agent.slug)
    await expect
      .poll(async () => {
        const agents = (await (await request.get('/api/agents')).json()) as Array<{
          slug: string
          dashboards?: Array<{ slug: string }>
        }>
        return agents.find((candidate) => candidate.slug === agent.slug)?.dashboards?.length
      })
      .toBe(1)

    await page.goto('/')
    const widget = page.locator(`[data-widget-id="${agent.slug}"]`)
    const dashboardWidget = page.locator(
      `[data-widget-id="dash::${agent.slug}::arrange-dashboard"]`
    )
    await expect(widget).toBeVisible({ timeout: 15_000 })
    await expect(dashboardWidget).toBeVisible({ timeout: 15_000 })
    await widget.scrollIntoViewIfNeeded()
    await expect(widget.locator('button button')).toHaveCount(0)
    await expect(widget.getByRole('link', { name: `Open ${agent.name}` })).toHaveAttribute(
      'draggable',
      'false'
    )
    const dashboardLink = dashboardWidget.getByRole('link', { name: 'Open app' })
    await expect(dashboardLink).toHaveAttribute('draggable', 'false')
    await expect(dashboardLink).toHaveAttribute('data-widget-drag-surface')

    // The card keeps a single visible/menu affordance model. Keyboard users
    // can invoke the same context menu from the focused link with Shift+F10.
    await expect(widget.getByRole('button', { name: `Options for ${agent.name}` })).toHaveCount(0)
    await widget.getByRole('link', { name: `Open ${agent.name}` }).focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menuitemcheckbox', { name: 'Expanded' })).toBeVisible()
    await page.keyboard.press('Escape')
    // Wait out the Radix menu teardown: it holds pointer-events:none on <body>
    // slightly past close, which would swallow the pointerdown of the drag.
    await expect(page.getByRole('menuitemcheckbox', { name: 'Expanded' })).not.toBeVisible()
    await page.waitForFunction(() => document.body.style.pointerEvents !== 'none')

    // Outside Arrange mode, desktop still supports direct pointer reordering.
    // The full-card anchor must not hand the gesture to native HTML link drag.
    const directSaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.request().postData()?.includes('homeGridLayout') === true &&
        response.ok(),
      { timeout: 15_000 }
    )
    await dragTile(page, dashboardWidget, 180)
    await directSaved

    await page.getByRole('button', { name: 'Agent layout options' }).click()
    await page.getByTestId('home-arrange-action').click()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

    // Dashboard anchors also remain grid drag surfaces in desktop Arrange.
    await dragTile(page, dashboardWidget, 180)

    // Arrange owns pointer dragging, but desktop right-click still bubbles
    // through its overlay to the unified agent context menu.
    await widget.click({ button: 'right', position: { x: 30, y: 30 } })
    await expect(page.getByTestId('agent-settings-item')).toBeVisible()
    const expanded = page.getByRole('menuitemcheckbox', { name: 'Expanded' })
    await expect(expanded).toBeVisible()
    await expanded.click()
    // Changing the card size remounts its context-menu trigger, so reopen the
    // unified menu on the newly rendered card before toggling the app row.
    await widget.click({ button: 'right', position: { x: 30, y: 30 } })
    const showApp = page.getByRole('menuitemcheckbox', { name: 'Show app' })
    await expect(showApp).toBeVisible()
    await showApp.click({ force: true })
    // Arrange is transactional: this hides the tile locally, but must not PUT
    // until Done commits both the layout and visibility changes.
    await expect(dashboardWidget).not.toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('agent-settings-item')).not.toBeVisible()
    // Same Radix teardown wait as above before the next pointer gesture.
    await page.waitForFunction(() => document.body.style.pointerEvents !== 'none')

    await dragTile(page, widget, 280)

    const layoutSaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.request().postData()?.includes('homeGridLayout') === true &&
        response.ok(),
      { timeout: 15_000 }
    )
    const visibilitySaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.request().postData()?.includes('hiddenAppCards') === true &&
        response.ok(),
      { timeout: 15_000 }
    )
    await page.getByRole('button', { name: 'Done' }).click()
    await Promise.all([layoutSaved, visibilitySaved])

    const settings = (await (await request.get('/api/user-settings')).json()) as {
      homeGridLayout?: Record<string, { x: number; y: number; w: number; h: number }>
      hiddenAppCards?: string[]
    }
    expect(settings.homeGridLayout?.[agent.slug]).toMatchObject({ w: 1, h: 1 })
    expect(settings.hiddenAppCards).toContain(agent.slug)

    await page.reload()
    await expect(page.locator(`[data-widget-id="${agent.slug}"]`)).toBeVisible({ timeout: 15_000 })
    const afterReload = (await (await request.get('/api/user-settings')).json()) as {
      homeGridLayout?: Record<string, { x: number; y: number; w: number; h: number }>
    }
    expect(afterReload.homeGridLayout?.[agent.slug]).toEqual(settings.homeGridLayout?.[agent.slug])

    const desktopRect = settings.homeGridLayout?.[agent.slug]
    expect(desktopRect).toBeDefined()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    const mobileWidget = page.locator(`[data-widget-id="${agent.slug}"]`)
    await expect(mobileWidget).toBeVisible({ timeout: 15_000 })
    await mobileWidget.scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: 'Agent layout options' }).click()
    await page.getByTestId('home-arrange-action').click()
    // Dragging the agent card on mobile is only eligible once Arrange mode
    // has rendered (dragEnabled flips in the same React commit that shows the
    // Done button). Starting the drag before that commit lands makes the
    // pointerdown a no-op: nothing commits, Done PUTs nothing, and the
    // homeGridMobileLayout wait below hangs to the test timeout — this was a
    // consistent CI failure on slower runners.
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

    await dragTile(page, mobileWidget, 180)

    const mobileSaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.request().postData()?.includes('homeGridMobileLayout') === true &&
        response.ok(),
      { timeout: 15_000 }
    )
    await page.getByRole('button', { name: 'Done' }).click()
    await mobileSaved

    const afterMobileArrange = (await (await request.get('/api/user-settings')).json()) as {
      homeGridLayout?: Record<string, { x: number; y: number; w: number; h: number }>
      homeGridMobileLayout?: Record<string, { x: number; y: number; w: number; h: number }>
    }
    expect(afterMobileArrange.homeGridMobileLayout?.[agent.slug]).toBeDefined()
    expect(afterMobileArrange.homeGridLayout?.[agent.slug]).toEqual(desktopRect)
  })
})
