import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createAgent, uniqueName } from '../helpers/agents'

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
          dashboardCount?: number
        }>
        return agents.find((candidate) => candidate.slug === agent.slug)?.dashboardCount
      })
      .toBe(1)

    await page.goto('/')
    const widget = page.locator(`[data-widget-id="${agent.slug}"]`)
    await expect(widget).toBeVisible({ timeout: 15_000 })
    await widget.scrollIntoViewIfNeeded()
    await expect(widget.locator('button button')).toHaveCount(0)

    await page.getByRole('button', { name: 'Agent layout options' }).click()
    await page.getByTestId('home-arrange-action').click()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()

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
    const visibilitySaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.ok()
    )
    await showApp.click({ force: true })
    await visibilitySaved
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('agent-settings-item')).not.toBeVisible()

    const before = await widget.boundingBox()
    expect(before).not.toBeNull()
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
    await page.mouse.down()
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2 + 280, {
      steps: 8,
    })
    await page.mouse.up()

    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.ok()
    )
    await page.getByRole('button', { name: 'Done' }).click()
    await saved

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

    const beforeMobile = await mobileWidget.boundingBox()
    expect(beforeMobile).not.toBeNull()
    await page.mouse.move(
      beforeMobile!.x + beforeMobile!.width / 2,
      beforeMobile!.y + beforeMobile!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      beforeMobile!.x + beforeMobile!.width / 2,
      beforeMobile!.y + beforeMobile!.height / 2 + 180,
      { steps: 8 }
    )
    await page.mouse.up()

    const mobileSaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/user-settings') &&
        response.request().method() === 'PUT' &&
        response.request().postData()?.includes('homeGridMobileLayout') === true &&
        response.ok()
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
