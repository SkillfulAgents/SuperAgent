import { test, expect } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  type TestAgent,
} from '../helpers/agents'

// A background subagent can park on request_browser_input while the main turn
// stays open (its request arrives as a sidechain message, not on the main
// stream). The user-visible contract is the same as a main-agent request: the
// card shows AND the agent-level status flips to awaiting_input (orange dot).
// Regression: the sidechain path only broadcast the card, so the agent sat
// labeled "working" while it was actually blocked on the user.
test.describe('Subagent Browser Input Status', () => {
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 45000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    agent = await createAgent(request, uniqueName(testInfo, 'Subagent Browser Agent'))
    await gotoAgentHome(page, agent)
  })

  test('browser input requested by a subagent shows the card and flips status to awaiting_input', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`subagent browser input ${uniqueSuffix(testInfo)}`)

    // The request card appears (this worked before the fix)
    const card = page.getByTestId('browser-input-request')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('Log in to GitHub to finish the submission.')

    // THE BUG: agent status stayed 'working' for subagent-originated requests
    await agentPage.waitForStatus('awaiting_input', 15000)
  })

  test('declining the subagent browser input request returns the agent to idle', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`subagent browser input ${uniqueSuffix(testInfo)}`)

    await expect(page.getByTestId('browser-input-request')).toBeVisible({ timeout: 15000 })
    await agentPage.waitForStatus('awaiting_input', 15000)

    await page.getByTestId('browser-input-decline-btn').click()

    // Declining resolves the pending input; the mock ends the turn and the
    // awaiting state must not stick around.
    await expect(page.getByTestId('browser-input-request')).toHaveCount(0, { timeout: 10000 })
    await agentPage.waitForStatus('idle', 15000)
  })
})
