import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

async function setupDashboardTaskTest(page: Page) {
  const appPage = new AppPage(page)
  const agentPage = new AgentPage(page)
  const sessionPage = new SessionPage(page)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()

  return { appPage, agentPage, sessionPage }
}

test.describe('Dashboard & Scheduled Task Tool Rendering', () => {
  test('schedule task tool renders with cron and task details', async ({ page }) => {
    const { agentPage, sessionPage } = await setupDashboardTaskTest(page)
    const agentName = `Schedule Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Trigger the "schedule task" scenario
    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)
    await sessionPage.waitForInputEnabled(15000)

    // Verify the schedule task tool call is rendered
    const toolCall = sessionPage.getToolCall('mcp__user-input__schedule_task')
    await expect(toolCall).toBeVisible()

    // The tool call should show the schedule summary with task name
    await expect(toolCall).toContainText('Daily Issue Summary')
  })

  test('schedule task tool call can be expanded', async ({ page }) => {
    const { agentPage, sessionPage } = await setupDashboardTaskTest(page)
    const agentName = `Schedule Expand ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)
    await sessionPage.waitForInputEnabled(15000)

    const toolCall = sessionPage.getToolCall('mcp__user-input__schedule_task')
    await expect(toolCall).toBeVisible()

    // Click to expand. Under high parallelism the tool call can remount as the
    // final message state arrives, so assert the expanded-only prompt text and
    // retry the click until that state sticks.
    await expect(async () => {
      const prompt = toolCall.getByText('Check for new issues and summarize them')
      if (!(await prompt.isVisible().catch(() => false))) {
        await toolCall.getByRole('button', { name: /Schedule Task/ }).click()
      }
      await expect(prompt).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 10000 })

    // Expanded view should show schedule details
    await expect(toolCall).toContainText('Recurring')
    await expect(toolCall).toContainText('Weekdays at 9:00 AM')
    await expect(toolCall).toContainText('America/New York')
  })

  test('scheduled task is created in the database and appears on agent home', async ({ page }) => {
    const { appPage, agentPage, sessionPage } = await setupDashboardTaskTest(page)
    const agentName = `Schedule DB ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)
    await sessionPage.waitForInputEnabled(15000)

    // Wait for the tool call to complete
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)

    // Scheduled tasks now live on the agent home page (under the "Triggers"
    // section), not in the sidebar. The breadcrumb is the stable way to leave
    // the current session for this same selected agent.
    await page.locator('[data-testid="agent-breadcrumb"]').click()

    const main = appPage.getMainContent()
    // Role-scoped: the section's empty state ("No triggers yet" / "Triggers
    // fire your agent…") also contains the word "Triggers", and bare
    // getByText trips strict mode while the task is still being created.
    await expect(main.getByRole('button', { name: 'Triggers' })).toBeVisible({ timeout: 5000 })
    await expect(main.getByText('Daily Issue Summary')).toBeVisible({ timeout: 10000 })
  })
})
