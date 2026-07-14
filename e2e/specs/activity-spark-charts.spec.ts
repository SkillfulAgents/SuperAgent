import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

function getCurrentAgentSlug(page: Page) {
  const match = page.url().match(/\/agents\/([^/?#]+)/)
  expect(match).toBeTruthy()
  return match![1]
}

async function waitForDailyIssueSummaryTask(request: APIRequestContext, agentSlug: string) {
  await expect.poll(async () => {
    const response = await request.get(`/api/agents/${agentSlug}/scheduled-tasks`)
    if (!response.ok()) return false
    const tasks = await response.json() as Array<{ name?: string }>
    return tasks.some((task) => task.name === 'Daily Issue Summary')
  }, { timeout: 20000 }).toBe(true)
}

test.describe('Activity spark charts', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('a new cron task renders its spark chart on agent home from the activity endpoint', async ({ page, request }) => {
    const agentName = `Activity Chart ${Date.now()}`
    await agentPage.createAgent(agentName)
    const agentSlug = getCurrentAgentSlug(page)

    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.waitForResponse(15000)
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)
    await waitForDailyIssueSummaryTask(request, agentSlug)

    // The activity endpoint returns a (empty, pre-history) series for every
    // cron task, so the chart must render its placeholder grid — not vanish.
    await agentPage.selectAgent(agentName)
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible({ timeout: 10000 })

    const chart = appPage.getMainContent().getByRole('img', {
      name: 'Daily Issue Summary schedule: no mature planned runs yet.',
    })
    await expect(chart).toBeVisible({ timeout: 10000 })

    // Once the chart is in, the loading skeleton must be gone (no layout churn).
    await expect(appPage.getMainContent().locator('[data-testid="activity-chart-skeleton"]')).toHaveCount(0)

    // The endpoint itself responds with the agent-scoped shape.
    const response = await request.get(`/api/activity/agents/${agentSlug}?days=14&tz=0`)
    expect(response.ok()).toBe(true)
    const stats = await response.json() as { cronByTaskId: Record<string, unknown[]> }
    expect(Object.keys(stats.cronByTaskId)).toHaveLength(1)
  })
})
