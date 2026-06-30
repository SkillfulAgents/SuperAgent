import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('Dashboard & Scheduled Task Tool Rendering', () => {
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

  test('schedule task tool renders with cron and task details', async ({ page }) => {
    const agentName = `Schedule Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Trigger the "schedule task" scenario
    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.waitForResponse(15000)

    // Verify the schedule task tool call is rendered
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)
    const toolCall = sessionPage.getToolCall('mcp__user-input__schedule_task')
    await expect(toolCall).toBeVisible()

    // The tool call should show the schedule summary with task name
    await expect(toolCall).toContainText('Daily Issue Summary')
  })

  test('schedule task tool call can be expanded', async ({ page }) => {
    const agentName = `Schedule Expand ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.waitForResponse(15000)

    const toolCall = sessionPage.getToolCall('mcp__user-input__schedule_task')
    await expect(toolCall).toBeVisible()

    // Click to expand
    await toolCall.locator('button').first().click()

    // Expanded view should show schedule details
    await expect(toolCall).toContainText('Recurring')
    await expect(toolCall).toContainText('Weekdays at 9:00 AM')
    await expect(toolCall).toContainText('Check for new issues and summarize them')
    await expect(toolCall).toContainText('America/New York')
  })

  test('scheduled task is created in the database and appears on agent home', async ({ page: _page }) => {
    const agentName = `Schedule DB ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.waitForResponse(15000)

    // Wait for the tool call to complete
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)

    // Scheduled tasks live on the agent home page (under the "Triggers"
    // section), not in the sidebar. Click the agent row to clear the session
    // selection and land on AgentHome.
    await agentPage.selectAgent(agentName)

    const main = appPage.getMainContent()
    // Role-scoped: the section's empty state ("No triggers yet" / "Triggers
    // fire your agent…") also contains the word "Triggers", and bare
    // getByText trips strict mode while the task is still being created.
    await expect(main.getByRole('button', { name: 'Triggers' })).toBeVisible({ timeout: 5000 })
    await expect(main.getByText('Daily Issue Summary')).toBeVisible({ timeout: 10000 })
  })

  test('opening a scheduled task navigates to its own route and back returns home', async ({ page }) => {
    const agentName = `Task Route ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.waitForResponse(15000)
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)

    // Land on agent home where the task lives under "Triggers"
    await agentPage.selectAgent(agentName)
    const main = appPage.getMainContent()
    const taskRow = main.getByText('Daily Issue Summary')
    await expect(taskRow).toBeVisible({ timeout: 10000 })

    // Open the task → it has its own URL route
    await taskRow.click()
    await expect(page).toHaveURL(/\/tasks\/[^/]+$/)
    await expect(page.locator('[data-testid="scheduled-task-back-button"]')).toBeVisible()

    // Hard reload — the task route is URL-durable, restored from the path
    await appPage.reload()
    await expect(page).toHaveURL(/\/tasks\/[^/]+$/)
    await expect(page.locator('[data-testid="scheduled-task-back-button"]')).toBeVisible()

    // Back → agent home
    await page.locator('[data-testid="scheduled-task-back-button"]').click()
    await expect(page).toHaveURL(/\/agents\/[^/]+$/)
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
  })

  test('a cross-agent task deep-link canonicalizes to the task\'s true agent (P1-b)', async ({ page }) => {
    // Tasks are addressed globally by id, so /agents/<other>/tasks/<id> would
    // otherwise render the task under the WRONG agent's shell (mismatched chrome,
    // back-links, permission gating). The view redirects to the task's true agent.
    const ownerName = `Task Owner ${Date.now()}`
    await agentPage.createAgent(ownerName)
    await sessionPage.sendMessage('schedule task for daily issues')
    await sessionPage.waitForResponse(15000)
    await sessionPage.expectToolCall('mcp__user-input__schedule_task', 15000)

    // Open the task to capture its id + the owner's slug from the URL.
    await agentPage.selectAgent(ownerName)
    const taskRow = appPage.getMainContent().getByText('Daily Issue Summary')
    await expect(taskRow).toBeVisible({ timeout: 10000 })
    await taskRow.click()
    await expect(page).toHaveURL(/\/tasks\/[^/]+$/)
    const m = page.url().match(/\/agents\/([^/?#]+)\/tasks\/([^/?#]+)/)
    expect(m).toBeTruthy()
    const ownerSlug = m![1]
    const taskId = m![2]

    // Create a SECOND agent and deep-link the owner's task under ITS slug.
    const otherName = `Task Other ${Date.now()}`
    await agentPage.createAgent(otherName)
    const otherSlug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
    expect(otherSlug).toBeTruthy()
    expect(otherSlug).not.toBe(ownerSlug)

    await page.goto(`/agents/${otherSlug}/tasks/${taskId}`)
    // Redirects back to the owner (the task's true agent), not the other shell.
    await expect(page).toHaveURL(new RegExp(`/agents/${ownerSlug}/tasks/${taskId}$`))
    await expect(page.locator('[data-testid="scheduled-task-back-button"]')).toBeVisible()
  })

  test('a cross-agent chat deep-link canonicalizes to the integration\'s true agent, preserving ?session= (P1-b family)', async ({ page }) => {
    // Same canonicalize family as the task case above: chat integrations are
    // addressed globally by id, so /agents/<wrong>/chat/<id> would render the
    // integration under the wrong agent's shell (mismatched chrome + canManage
    // gating, and SessionThread fetches messages scoped to the URL slug → empty).
    // chat-integration-view.tsx:74-83 redirects (replace) to the integration's
    // true agent, preserving the `?session=` sub-session. Unlike tasks, chat
    // integrations ARE seedable in mock mode (POST /api/chat-integrations/<slug>).
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    // Agent A owns the integration. createAgent lands on A's agent-home.
    const ownerName = `Chat Canon Owner ${Date.now()}`
    await agentPage.createAgent(ownerName)
    const aSlug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
    expect(aSlug).toBeTruthy()

    // Seed a telegram integration for A and capture its globally-addressable id.
    const seedResp = await page.request.post(`/api/chat-integrations/${aSlug}`, {
      data: {
        provider: 'telegram',
        name: 'E2E Canon Bot',
        config: { botToken: `fake-${Date.now()}`, chatId: '12345' },
      },
    })
    expect(seedResp.ok()).toBeTruthy()

    const listResp = await page.request.get(`/api/agents/${aSlug}/chat-integrations`)
    expect(listResp.ok()).toBeTruthy()
    const integrations = await listResp.json() as Array<{ id: string; agentSlug: string }>
    expect(integrations.length).toBeGreaterThan(0)
    const integrationId = integrations[0].id
    expect(integrationId).toBeTruthy()
    // The integration is stored under the canonical agent id; the canonicalize
    // redirect lands there (the same id form the app uses for chat routes). The
    // captured `aSlug` from the URL is a stale display slug (deferred URL rewrite).
    const trueAgentSlug = integrations[0].agentSlug

    // Create agent B and deep-link A's integration under ITS slug, with a sub-session.
    const otherName = `Chat Canon Other ${Date.now()}`
    await agentPage.createAgent(otherName)
    const bSlug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
    expect(bSlug).toBeTruthy()
    expect(bSlug).not.toBe(aSlug)

    await page.goto(`/agents/${bSlug}/chat/${integrationId}?session=sample`)

    // Canonicalizes to A (the integration's true agent), preserving ?session=sample.
    await expect(page).toHaveURL(new RegExp(`/agents/${trueAgentSlug}/chat/${integrationId}\\?session=sample$`))

    // The owner's shell renders: agent breadcrumb + the integration header name.
    // Scope the name to main-content — the sidebar also lists integration.name,
    // so a bare getByText would trip strict mode.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()
    await expect(appPage.getMainContent().getByText('E2E Canon Bot')).toBeVisible({ timeout: 10000 })

    // The redirect path is crash-free (no wrong-slug render of B's shell).
    expect(errors).toEqual([])
  })
})
