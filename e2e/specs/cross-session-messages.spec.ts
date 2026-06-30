import { test, expect } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { createAgent as createAgentViaApi, gotoAgentHome, type TestAgent } from '../helpers/agents'

// Run serially to avoid conflicts
test.describe.configure({ mode: 'serial' })

test.describe('Cross-Session Message Isolation', () => {
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
  })

  function userMessage(text: string) {
    // `.first()` is deliberate: during reconciliation the optimistic
    // pending-user-message ghost and the persisted message-user briefly coexist
    // (both carry data-testid="message-user"), so a bare toBeVisible() on the
    // unscoped match trips Playwright strict mode under CI load. These checks only
    // assert the message is PRESENT; the isolation guarantee is asserted by the
    // getMessageList().not.toContainText(...) lines below.
    return sessionPage.getUserMessages().filter({ hasText: text }).first()
  }

  test('messages from one agent do not leak into another agent', async ({ page, request }) => {
    const ts = Date.now()
    const agentAName = `Agent A ${ts}`
    const agentBName = `Agent B ${ts}`
    const messageA = 'slow response for agent A'
    const messageB = 'Hello from agent B'
    const createdAgents: TestAgent[] = []

    try {
      // Create two agents
      const agentA = await createAgentViaApi(request, agentAName)
      const agentB = await createAgentViaApi(request, agentBName)
      createdAgents.push(agentA, agentB)

      // 1. Go to Agent A and send a slow message (triggers 3s delay)
      await gotoAgentHome(page, agentA)
      await sessionPage.sendMessage(messageA)

      // Wait for the message we just sent to appear.
      await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })

      // Verify Agent A is working (slow response takes 3s)
      await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 5000 })

      // 2. While Agent A is working, switch to Agent B
      await agentPage.selectAgent(agentBName)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentBName, { timeout: 15000 })

      // 3. Send a message to Agent B
      await sessionPage.sendMessage(messageB)
      await expect(userMessage(messageB)).toBeVisible({ timeout: 10000 })

      // Verify Agent B's message list does NOT contain Agent A's message
      const messageBList = sessionPage.getMessageList()
      await expect(messageBList).not.toContainText(messageA)

      // 4. Switch back to Agent A and select its session
      await agentPage.selectAgent(agentAName)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentAName, { timeout: 15000 })
      // Need to click on the session in the sidebar since switching agent deselects it
      await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentAName))

      // Wait for message list to appear
      const messageAList = sessionPage.getMessageList()
      await expect(messageAList).toBeVisible({ timeout: 5000 })

      // 5. Verify Agent A's messages do NOT contain Agent B's message
      await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })
      await expect(messageAList).not.toContainText(messageB)
    } finally {
      for (const agent of createdAgents) {
        await request.delete(`/api/agents/${agent.slug}`).catch(() => {})
      }
    }
  })

  test('pending optimistic message is scoped to session', async ({ page, request }) => {
    const ts = Date.now()
    const agentAName = `Pending A ${ts}`
    const agentBName = `Pending B ${ts}`
    const messageA = 'slow response test'
    const messageB = 'Quick message B'
    const createdAgents: TestAgent[] = []

    try {
      // Create two agents
      const agentA = await createAgentViaApi(request, agentAName)
      const agentB = await createAgentViaApi(request, agentBName)
      createdAgents.push(agentA, agentB)

      // Send slow message to Agent A
      await gotoAgentHome(page, agentA)
      await sessionPage.sendMessage(messageA)
      await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })

      // Agent A should be working
      await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 5000 })

      // Switch to Agent B and send a message
      await agentPage.selectAgent(agentBName)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentBName, { timeout: 15000 })
      await sessionPage.sendMessage(messageB)

      // Agent B should show its own message, not Agent A's
      await expect(userMessage(messageB)).toBeVisible({ timeout: 10000 })
      await expect(sessionPage.getMessageList()).not.toContainText(messageA)

      // Switch back to Agent A and select session
      await agentPage.selectAgent(agentAName)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentAName, { timeout: 15000 })
      await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentAName))

      // Agent A should show its message
      await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })

      // And should NOT have messageB anywhere
      const messageListA = sessionPage.getMessageList()
      await expect(messageListA).not.toContainText(messageB)
    } finally {
      for (const agent of createdAgents) {
        await request.delete(`/api/agents/${agent.slug}`).catch(() => {})
      }
    }
  })
})
