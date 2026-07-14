import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Allow/review/block launch policies for subagents (Task) and workflows.
 *
 * The mock scenarios stream a `Workflow` / `Task` tool_use through the real
 * MessagePersister, which applies the real policy gate (defaults: subagents
 * allow, workflows review) and broadcasts `capability_review_request`. The
 * card's decisions hit the real /capability-review route, which resolves or
 * rejects the mock container's pending input — same wiring as production.
 *
 * Sequential (opts out of fullyParallel): the settings test temporarily
 * flips GLOBAL policies, which would race the review-card tests in sibling
 * workers.
 */
test.describe.configure({ mode: 'default' })
test.describe('Capability launch review', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  const reviewCard = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="capability-review-request"]')

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `Capability Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('workflow launch under default settings shows the rich review card', async ({ page }) => {
    await sessionPage.sendMessage('launch workflow')

    const card = reviewCard(page)
    await expect(card).toBeVisible({ timeout: 15000 })

    // Rich pre-flight display parsed from the script meta
    await expect(card).toContainText('sample-audit')
    await expect(card).toContainText('Audit the sample data set')
    await expect(card).toContainText('2 phases')
    await expect(card).toContainText('Scan')
    await expect(card).toContainText('Verify')
  })

  test('Run approves the launch and the turn completes', async ({ page }) => {
    await sessionPage.sendMessage('launch workflow')
    await expect(reviewCard(page)).toBeVisible({ timeout: 15000 })

    await page.locator('[data-testid="capability-review-run-btn"]').click()

    await expect(reviewCard(page)).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
  })

  test('Block declines the launch and the turn continues', async ({ page }) => {
    await sessionPage.sendMessage('launch workflow')
    await expect(reviewCard(page)).toBeVisible({ timeout: 15000 })

    await page.locator('[data-testid="capability-review-block-btn"]').click()

    await expect(reviewCard(page)).toHaveCount(0, { timeout: 10000 })
    // The deny is a tool result the model adapts to — the session must settle,
    // not error out.
    await sessionPage.waitForInputEnabled(15000)
  })

  test('Allow for this session suppresses the next review prompt', async ({ page }) => {
    await sessionPage.sendMessage('launch workflow')
    await expect(reviewCard(page)).toBeVisible({ timeout: 15000 })

    await page.locator('[data-testid="capability-review-run-btn-chevron"]').click()
    await page.locator('[data-testid="capability-review-allow-session-btn"]').click()
    await expect(reviewCard(page)).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)

    // Second launch in the same session: the host-side grant suppresses the
    // review broadcast entirely. Wait for the full turn to settle — an
    // unwanted card would still be showing (nothing ever resolves it).
    await sessionPage.sendMessage('launch workflow')
    await sessionPage.waitForInputEnabled(15000)
    await expect(reviewCard(page)).toHaveCount(0)
  })

  test('subagent launches do not prompt under the default allow policy', async ({ page }) => {
    await sessionPage.sendMessage('launch subagent')

    // Wait for the whole turn (including the Task tool_use) to settle — an
    // unwanted card would still be showing (nothing ever resolves it).
    await sessionPage.waitForInputEnabled(15000)
    await expect(reviewCard(page)).toHaveCount(0)
  })
})

test.describe('Capability policy settings', () => {
  test('three-way controls persist and blocking subagents warns first', async ({ page }) => {
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-capabilities"]').click()

    const subagentsToggle = page.locator('[data-testid="capability-policy-subagents"]')
    const workflowsToggle = page.locator('[data-testid="capability-policy-workflows"]')

    // Defaults: subagents allow, workflows review
    await expect(subagentsToggle.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true')
    await expect(workflowsToggle.locator('[data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'true')

    // Selecting block for subagents opens the warning instead of applying
    await subagentsToggle.locator('[data-testid="policy-toggle-block"]').click()
    await expect(page.locator('[data-testid="block-subagents-use-review"]')).toBeVisible()

    // Cancel applies nothing
    await page.locator('[data-testid="block-subagents-cancel"]').click()
    await expect(page.locator('[data-testid="block-subagents-use-review"]')).toHaveCount(0)
    await expect(subagentsToggle.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true')

    // Take the recommended path — review is applied, not block
    await subagentsToggle.locator('[data-testid="policy-toggle-block"]').click()
    await expect(page.locator('[data-testid="block-subagents-use-review"]')).toBeVisible()
    await page.locator('[data-testid="block-subagents-use-review"]').click()
    await expect(subagentsToggle.locator('[data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'true', { timeout: 10000 })
    await expect(subagentsToggle.locator('[data-testid="policy-toggle-block"]')).toHaveAttribute('data-active', 'false')

    // Workflows -> allow persists across reload
    await workflowsToggle.locator('[data-testid="policy-toggle-allow"]').click()
    await expect(workflowsToggle.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true', { timeout: 10000 })

    await page.reload()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="capability-policy-workflows"] [data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true', { timeout: 10000 })

    // Restore defaults so other specs see the stock policy
    await page.locator('[data-testid="capability-policy-workflows"] [data-testid="policy-toggle-review"]').click()
    await expect(page.locator('[data-testid="capability-policy-workflows"] [data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'true', { timeout: 10000 })
    const subagents = page.locator('[data-testid="capability-policy-subagents"]')
    await subagents.locator('[data-testid="policy-toggle-allow"]').click()
    await expect(subagents.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true', { timeout: 10000 })
  })
})
