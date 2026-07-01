import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { SessionPage } from '../pages/session.page'
import {
  createAgent,
  expectPendingProxyReviewResolved,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  waitForCurrentSessionId,
  waitForPendingProxyReview,
  type TestAgent,
  type TestPendingProxyReview,
  type TestSession,
} from '../helpers/agents'


test.describe('Proxy Review Requests', () => {
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 60000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    sessionPage = new SessionPage(page)

    agent = await createAgent(request, uniqueName(testInfo, 'Review Agent'))
    await gotoAgentHome(page, agent)
  })

  async function sendReviewScenario(
    page: Page,
    request: APIRequestContext,
    testInfo: TestInfo,
    trigger: string,
    options: Parameters<typeof waitForPendingProxyReview>[2],
  ): Promise<{ session: Pick<TestSession, 'id'>; review: TestPendingProxyReview }> {
    await sessionPage.sendMessage(`${trigger} ${uniqueSuffix(testInfo)}`)
    const session = await waitForCurrentSessionId(page)
    const review = await waitForPendingProxyReview(request, agent, options)
    return { session, review }
  }

  test('proxy review: review prompt appears with correct details', async ({ page, request }, testInfo) => {
    // "proxy review" triggers ProxyReviewScenario
    const { review } = await sendReviewScenario(page, request, testInfo, 'proxy review', {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
      matchedScope: 'chat:write',
    })

    // Wait for the review prompt to appear
    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)

    // Verify the API details are shown
    const requestCard = sessionPage.getProxyReviewRequests(review.id)
    await expect(requestCard).toContainText('Allow send a message to a channel?')
    await expect(requestCard).toContainText('POST')
    await expect(requestCard).toContainText('api/chat.postMessage')
    await expect(requestCard).toContainText('slack')
  })

  test('proxy review: user can allow the request', async ({ page, request }, testInfo) => {
    const { review } = await sendReviewScenario(page, request, testInfo, 'proxy review', {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
    })

    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)

    // Allow the request
    await sessionPage.allowProxyReview(review.id)

    // Review prompt should disappear.
    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })

  test('proxy review: user can deny the request', async ({ page, request }, testInfo) => {
    const { review } = await sendReviewScenario(page, request, testInfo, 'proxy review', {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
    })

    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)

    // Deny the request
    await sessionPage.denyProxyReview(review.id)

    // Review prompt should disappear.
    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)

    // Session should complete with denial message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user', 0, 15000)
  })

  test('proxy review: remember always allow for scope', async ({ page, request }, testInfo) => {
    const { review } = await sendReviewScenario(page, request, testInfo, 'proxy review', {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
      matchedScope: 'chat:write',
    })

    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)

    // Click always allow for this scope (opens Allow popover, then clicks scope button)
    await sessionPage.alwaysAllowScope('chat:write', review.id)

    // Review prompt should disappear.
    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })

  test('proxy review: allow all requests for the minimal risk group', async ({ page, request }, testInfo) => {
    const { review } = await sendReviewScenario(page, request, testInfo, 'proxy review', {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
      matchedScope: 'chat:write',
    })

    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)

    // chat.postMessage is satisfied by chat:write (a "write"-labelled scope), so the
    // minimal group offered is "write". Allowing it should approve and persist '*write'.
    await sessionPage.alwaysAllowLabelGroup('write', review.id)

    // Review prompt should disappear.
    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })
})

test.describe('X-Agent Review Requests', () => {
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 60000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    sessionPage = new SessionPage(page)

    agent = await createAgent(request, uniqueName(testInfo, 'XAgent Review Agent'))
    await gotoAgentHome(page, agent)
  })

  async function sendXAgentReviewScenario(
    page: Page,
    request: APIRequestContext,
    testInfo: TestInfo,
  ): Promise<{ session: Pick<TestSession, 'id'>; review: TestPendingProxyReview }> {
    await sessionPage.sendMessage(`x-agent review ${uniqueSuffix(testInfo)}`)
    const session = await waitForCurrentSessionId(page)
    const review = await waitForPendingProxyReview(request, agent, {
      xAgent: true,
      toolkit: 'agents',
      matchedScope: 'list',
    })
    expect(review.xAgent?.operation).toBe('list')
    return { session, review }
  }

  test('x-agent review: interrupt dismisses the review card', async ({ page, request }, testInfo) => {
    // "x-agent review" triggers XAgentReviewScenario
    const { review } = await sendXAgentReviewScenario(page, request, testInfo)

    // Wait for the x-agent review prompt to appear
    await sessionPage.waitForXAgentReviewRequestById(review.id, 35000)

    // Click the X (stop session) button on the card
    await sessionPage.stopSessionFromRequest(sessionPage.getXAgentReviewRequests(review.id))

    // Review prompt should disappear
    await expect(sessionPage.getXAgentReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
  })

  test('x-agent review: user can allow the request', async ({ page, request }, testInfo) => {
    const { review } = await sendXAgentReviewScenario(page, request, testInfo)

    await sessionPage.waitForXAgentReviewRequestById(review.id, 35000)

    // Verify the card shows the right text
    const requestCard = sessionPage.getXAgentReviewRequests(review.id)
    await expect(requestCard).toContainText('list other agents in this workspace')

    // Allow the request
    await sessionPage.allowXAgentReview(review.id)

    // Review prompt should disappear.
    await expect(sessionPage.getXAgentReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)

    // Session should complete with approval message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })

  test('x-agent review: user can deny the request', async ({ page, request }, testInfo) => {
    const { review } = await sendXAgentReviewScenario(page, request, testInfo)

    await sessionPage.waitForXAgentReviewRequestById(review.id, 35000)

    // Deny the request
    await sessionPage.denyXAgentReview(review.id)

    // Review prompt should disappear.
    await expect(sessionPage.getXAgentReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)

    // Session should complete with denial message
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user', 0, 15000)
  })
})
