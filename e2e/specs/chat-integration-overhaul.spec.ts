/**
 * E2E coverage for the cron-page-style chat integration view.
 *
 * Seedability constraint (mock mode):
 *   - Chat integrations ARE seedable via POST /api/chat-integrations/<slug>.
 *   - Chat sessions and access rows are NOT seedable via any public API in mock
 *     mode. Behaviors that depend on them are exercised at the unit level instead:
 *     conversation-history-section.test renders the inbox + rows (directly
 *     asserting opening a conversation and the Unblock/Block approve/revoke
 *     actions), chat-inbox-model.test covers the row ordering/collapsing data
 *     model, and conversation-detail.test covers the per-chat window switcher
 *     (>1 window). The comments below note the remaining deferred cases.
 */
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { createAgentWithTelegramIntegration } from '../helpers/chat-integrations'

test.describe('Chat integration UI overhaul', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('Remote Chat card on agent-home lists a seeded integration and navigates to the chat view on click', async ({
    page,
  }) => {
    const agentName = `Chat Overhaul ${Date.now()}`
    const { slug, integrationId } = await createAgentWithTelegramIntegration(page, agentPage, {
      agentName,
      integrationName: 'E2E Overhaul Bot',
    })

    // Navigate to agent-home so React Query fetches the freshly-seeded integration.
    await page.goto(`/agents/${slug}`)

    // The Remote Chat HomeCollapsible lists the integration row.
    const mainContent = appPage.getMainContent()
    await expect(mainContent.getByText('Remote Chat')).toBeVisible()
    await expect(mainContent.getByText('E2E Overhaul Bot')).toBeVisible({ timeout: 10000 })

    // Click the integration row - IntegrationRow renders role="button" when interactive.
    await mainContent.getByRole('button', { name: /E2E Overhaul Bot/i }).click()

    // Should navigate to /agents/<slug>/chat/<integrationId>.
    // Assert on the integration id, not the agent slug: the view canonicalizes a
    // display slug ({name}-{id}) to the true agent id, so the slug segment may change.
    // (Canonicalization itself is covered by dashboard-and-tasks' deep-link test.)
    await expect(page).toHaveURL(new RegExp(`/chat/${integrationId}`))

    // Conversation history region is visible; no sessions exist in mock mode so the
    // empty state is shown. Session-switching via the dropdown requires seedable
    // session rows and is covered by unit tests.
    await expect(
      mainContent.getByText('Send a message from Telegram to start')
    ).toBeVisible({ timeout: 10000 })

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('chat view shows the settings cards and folds access into the conversation inbox; sidebar has no chat sub-nav entry', async ({
    page,
  }) => {
    const agentName = `Chat Overhaul Panel ${Date.now()}`
    const { slug, integrationId } = await createAgentWithTelegramIntegration(page, agentPage, {
      agentName,
      integrationName: 'E2E Panel Bot',
      chatId: '99999',
    })

    // Navigate directly to the chat view.
    await page.goto(`/agents/${slug}/chat/${integrationId}`)
    // Assert on the integration id, not the agent slug: the view canonicalizes a
    // display slug ({name}-{id}) to the true agent id, so the slug segment may change.
    // (Canonicalization itself is covered by dashboard-and-tasks' deep-link test.)
    await expect(page).toHaveURL(new RegExp(`/chat/${integrationId}`))

    const mainContent = appPage.getMainContent()

    // Conversation history empty state - no sessions in mock mode.
    await expect(
      mainContent.getByText('Send a message from Telegram to start')
    ).toBeVisible({ timeout: 10000 })

    // The right column renders at >= 1024px (lg). The Playwright default viewport
    // is 1280x720, so the non-collapsible settings cards are visible. Their labels
    // are DetailCard headings (plain text), matching the cron page layout.

    // Settings cards (canManage gate is open in mock mode for the creating user).
    await expect(mainContent.getByText('Status', { exact: true })).toBeVisible()
    await expect(mainContent.getByText('Conversation Settings', { exact: true })).toBeVisible()
    await expect(mainContent.getByText('Model & Effort', { exact: true })).toBeVisible()

    // Access control is folded into the conversation inbox (no separate Access
    // card): the Telegram owner sees the require-approval toggle above the chat
    // list. Approve/deny/revoke interactions require seedable access rows; those
    // are covered by conversation-history-section.test.
    await expect(
      mainContent.getByText('Require approval for new conversations')
    ).toBeVisible()
    await expect(mainContent.getByText('Access', { exact: true })).toHaveCount(0)

    // KEY regression guard: the left sidebar shows NO chat-integration sub-nav
    // entry for this agent. Task 9 removed the dedicated chat tab; the submenu
    // now lists only sessions and dashboards.
    // `a[href*="/chat/"]` would exist if a nav link to the chat route were
    // rendered in the sidebar - its absence proves the removal held.
    await expect(appPage.getSidebar().locator('a[href*="/chat/"]')).toHaveCount(0)

    // Cleanup
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })
})
