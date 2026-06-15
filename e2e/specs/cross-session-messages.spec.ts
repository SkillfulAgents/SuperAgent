import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { getE2EBaseUrl } from '../helpers/base-url'
import { createAgent, openAgentHome, type TestAgent } from '../helpers/agents'

const API = getE2EBaseUrl()

// Run this file serially because the two scenarios exercise concurrent sessions
// against the same browser page shape.
test.describe.configure({ mode: 'serial' })

test.describe('Cross-Session Message Isolation', () => {
  let appPage: AppPage
  let sessionPage: SessionPage
  let agentsToDelete: TestAgent[]

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    sessionPage = new SessionPage(page)
    agentsToDelete = []
  })

  test.afterEach(async ({ page, request }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) {
      await page.close().catch(() => {})
    }

    for (const agent of [...agentsToDelete].reverse()) {
      try {
        await request.delete(`${API}/api/agents/${agent.slug}`)
      } catch {
        // Keep teardown best-effort so the original failure stays visible.
      }
    }
  })

  async function seedAgent(request: APIRequestContext, name: string) {
    const agent = await createAgent(request, name)
    agentsToDelete.push(agent)
    return agent
  }

  async function setupAgents(page: Page, request: APIRequestContext, testId: string) {
    const agentA = await seedAgent(request, `Agent A ${testId}`)
    const agentB = await seedAgent(request, `Agent B ${testId}`)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    return { agentA, agentB }
  }

  async function startSessionFromHome(page: Page, agent: TestAgent, message: string) {
    const expectedPath = `/api/agents/${agent.slug}/sessions`
    const responsePromise = page.waitForResponse((response) => {
      return response.request().method() === 'POST'
        && response.url().includes(expectedPath)
    }, { timeout: 15000 })

    await sessionPage.sendMessage(message)
    const response = await responsePromise
    expect(response.ok()).toBeTruthy()

    const session = (await response.json()) as { id?: string }
    expect(session.id).toBeTruthy()
    await expect(sessionPage.getMessageList()).toBeVisible({ timeout: 15000 })

    return session.id!
  }

  async function openSession(page: Page, agent: TestAgent, sessionId: string) {
    await openAgentHome(page, agent)
    await sessionPage.selectSessionOnAgentHome(sessionId)
  }

  const userMessage = (text: string) => {
    return sessionPage.getUserMessages().filter({ hasText: text })
  }

  test('messages from one agent do not leak into another agent', async ({ page, request }, testInfo) => {
    const testId = `${testInfo.workerIndex}-${Date.now()}`
    const messageA = 'slow response for agent A'
    const messageB = 'Hello from agent B'
    const { agentA, agentB } = await setupAgents(page, request, testId)

    // 1. Go to Agent A and send a slow message (triggers 3s delay)
    await openAgentHome(page, agentA)
    const sessionAId = await startSessionFromHome(page, agentA, messageA)

    await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })

    // Verify Agent A is working (slow response takes 3s)
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 5000 })

    // 2. While Agent A is working, switch to Agent B
    await openAgentHome(page, agentB)
    await startSessionFromHome(page, agentB, messageB)
    await expect(userMessage(messageB)).toBeVisible({ timeout: 10000 })

    // Verify Agent B's message list does NOT contain Agent A's message
    const messageBList = sessionPage.getMessageList()
    await expect(messageBList).not.toContainText(messageA)

    // 4. Switch back to Agent A and select its session
    await openSession(page, agentA, sessionAId)

    // Wait for message list to appear
    const messageAList = sessionPage.getMessageList()
    await expect(messageAList).toBeVisible({ timeout: 5000 })

    // 5. Verify Agent A's messages do NOT contain Agent B's message
    await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })
    await expect(messageAList).not.toContainText(messageB)
    await sessionPage.waitForInputEnabled(10000)
  })

  test('pending optimistic message is scoped to session', async ({ page, request }, testInfo) => {
    const testId = `pending-${testInfo.workerIndex}-${Date.now()}`
    const messageA = 'slow response test'
    const messageB = 'Quick message B'
    const { agentA, agentB } = await setupAgents(page, request, testId)

    // Send slow message to Agent A
    await openAgentHome(page, agentA)
    const sessionAId = await startSessionFromHome(page, agentA, messageA)
    await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })

    // Agent A should be working
    await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 5000 })

    // Switch to Agent B and send a message
    await openAgentHome(page, agentB)
    await startSessionFromHome(page, agentB, messageB)

    // Agent B should show its own message, not Agent A's
    await expect(userMessage(messageB)).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getMessageList()).not.toContainText(messageA)

    // Switch back to Agent A and select session
    await openSession(page, agentA, sessionAId)

    // Agent A should show its message
    await expect(userMessage(messageA)).toBeVisible({ timeout: 10000 })

    // And should NOT have messageB anywhere
    const messageListA = sessionPage.getMessageList()
    await expect(messageListA).not.toContainText(messageB)
    await sessionPage.waitForInputEnabled(10000)
  })
})
