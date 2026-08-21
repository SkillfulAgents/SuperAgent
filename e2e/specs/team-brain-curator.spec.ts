import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { createAgent, getAgentItem, gotoAgentHome, uniqueName } from '../helpers/agents'

async function curatorSlug(request: APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/brain/curator')
  expect(res.ok()).toBeTruthy()
  const body = await res.json() as { enabled?: boolean; agentSlug: string | null }
  return body.agentSlug
}

async function toggleCurator(page: Page, agentPage: AgentPage) {
  await agentPage.openSettings()
  await page.locator('[data-testid="agent-settings-nav-general"]').click()
  const sw = page.locator('[data-testid="brain-curator-switch"]')
  await expect(sw).toBeVisible()
  const put = page.waitForResponse((res) => (
    res.url().includes('/api/brain/curator')
    && res.request().method() === 'PUT'
    && res.ok()
  ))
  await sw.click()
  await put
  const dialog = page.locator('[data-testid="agent-settings-dialog"]')
  await dialog.getByRole('button', { name: /^Cancel$/ }).click()
  await expect(dialog).not.toBeVisible({ timeout: 10000 })
}

test.describe('Team Brain curator', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.afterEach(async ({ request }) => {
    const restore = await request.put('/api/settings', { data: { teamBrain: false } })
    expect(restore.ok()).toBeTruthy()
  })

  test.beforeEach(async ({ page, request }) => {
    const enable = await request.put('/api/settings', { data: { teamBrain: true } })
    expect(enable.ok()).toBeTruthy()
    const clear = await request.put('/api/brain/curator', { data: { agentSlug: null } })
    expect(clear.ok()).toBeTruthy()
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('set, switch, and clear the workspace curator', async ({ page, request }, testInfo) => {
    test.setTimeout(60_000)
    const first = await createAgent(request, uniqueName(testInfo, 'Brain First'))
    const second = await createAgent(request, uniqueName(testInfo, 'Brain Second'))
    expect(await curatorSlug(request)).toBeNull()

    await gotoAgentHome(page, first)
    await toggleCurator(page, agentPage)
    await expect.poll(() => curatorSlug(request)).toBe(first.slug)
    await expect(getAgentItem(page, first).getByTestId('brain-curator-badge')).toBeVisible()
    await expect(page.getByTestId('main-content').getByTestId('brain-curator-badge')).toBeVisible()

    await gotoAgentHome(page, second)
    await toggleCurator(page, agentPage)
    await expect.poll(() => curatorSlug(request)).toBe(second.slug)
    await expect(getAgentItem(page, second).getByTestId('brain-curator-badge')).toBeVisible()
    await expect(getAgentItem(page, first).getByTestId('brain-curator-badge')).toHaveCount(0)

    await toggleCurator(page, agentPage)
    await expect.poll(() => curatorSlug(request)).toBeNull()
    await expect(getAgentItem(page, second).getByTestId('brain-curator-badge')).toHaveCount(0)
  })
})
