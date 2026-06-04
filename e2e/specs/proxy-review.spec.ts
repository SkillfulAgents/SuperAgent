import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'


test.describe('Proxy Review Requests', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Use unique agent name per test
    testAgentName = `Review Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('proxy review: review prompt appears with correct details', async ({ page }) => {
    // "proxy review" triggers ProxyReviewScenario
    await sessionPage.sendMessage('proxy review')

    // Wait for the review prompt to appear
    await sessionPage.waitForProxyReviewRequest()

    // Verify the API details are shown
    const request = sessionPage.getProxyReviewRequests().first()
    await expect(request).toContainText('Allow send a message to a channel?')
    await expect(request).toContainText('POST')
    await expect(request).toContainText('api/chat.postMessage')
    await expect(request).toContainText('slack')
  })

  test('proxy review: user can allow the request', async ({ page }) => {
    await sessionPage.sendMessage('proxy review')

    await sessionPage.waitForProxyReviewRequest()

    // Allow the request
    await sessionPage.allowProxyReview()

    // Review prompt should disappear
    await expect(sessionPage.getProxyReviewRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user')
  })

  test('proxy review: user can deny the request', async ({ page }) => {
    await sessionPage.sendMessage('proxy review')

    await sessionPage.waitForProxyReviewRequest()

    // Deny the request
    await sessionPage.denyProxyReview()

    // Review prompt should disappear
    await expect(sessionPage.getProxyReviewRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete with denial message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user')
  })

  test('proxy review: remember always allow for scope', async ({ page }) => {
    await sessionPage.sendMessage('proxy review')

    await sessionPage.waitForProxyReviewRequest()

    // Click always allow for this scope (opens Allow popover, then clicks scope button)
    await sessionPage.alwaysAllowScope('chat:write')

    // Review prompt should disappear
    await expect(sessionPage.getProxyReviewRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user')
  })

  test('proxy review: allow all requests for the minimal risk group', async ({ page }) => {
    await sessionPage.sendMessage('proxy review')

    await sessionPage.waitForProxyReviewRequest()

    // chat.postMessage is satisfied by chat:write (a "write"-labelled scope), so the
    // minimal group offered is "write". Allowing it should approve and persist '*write'.
    await sessionPage.alwaysAllowLabelGroup('write')

    // Review prompt should disappear
    await expect(sessionPage.getProxyReviewRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user')
  })
})

test.describe('X-Agent Review Requests', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `XAgent Review Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('x-agent review: interrupt dismisses the review card', async ({ page }) => {
    // "x-agent review" triggers XAgentReviewScenario
    await sessionPage.sendMessage('x-agent review')

    // Wait for the x-agent review prompt to appear
    await sessionPage.waitForXAgentReviewRequest()

    // Click the X (stop session) button on the card
    await sessionPage.stopSessionFromRequest()

    // Review prompt should disappear
    await expect(sessionPage.getXAgentReviewRequests()).toHaveCount(0, { timeout: 10000 })
  })

  test('x-agent review: user can allow the request', async ({ page }) => {
    await sessionPage.sendMessage('x-agent review')

    await sessionPage.waitForXAgentReviewRequest()

    // Verify the card shows the right text
    const request = sessionPage.getXAgentReviewRequests().first()
    await expect(request).toContainText('list other agents in this workspace')

    // Allow the request
    await sessionPage.allowXAgentReview()

    // Review prompt should disappear
    await expect(sessionPage.getXAgentReviewRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user')
  })

  test('x-agent review: user can deny the request', async ({ page }) => {
    await sessionPage.sendMessage('x-agent review')

    await sessionPage.waitForXAgentReviewRequest()

    // Deny the request
    await sessionPage.denyXAgentReview()

    // Review prompt should disappear
    await expect(sessionPage.getXAgentReviewRequests()).toHaveCount(0, { timeout: 10000 })

    // Session should complete with denial message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user')
  })
})
