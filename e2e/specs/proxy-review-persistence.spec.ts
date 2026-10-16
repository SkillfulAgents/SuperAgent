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
} from '../helpers/agents'

/**
 * Proxy-review policy PERSISTENCE: a one-time decision on a review card must not
 * write a scope policy. Rules are changed only through the permissions editor,
 * which the card opens for an owned account.
 *
 * Each test drives its review against its OWN connected account via the
 * `account_id=<id>` scenario token: apiScopePolicies is keyed by
 * (accountId, scope), so without a per-test account the persisted rows would
 * collide across the 6 parallel workers.
 */

interface ScopePolicy {
  scope: string
  decision: string
  accountId: string
}

test.describe('Proxy review policy persistence', () => {
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 60000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    sessionPage = new SessionPage(page)
    agent = await createAgent(request, uniqueName(testInfo, 'Policy Persist Agent'))
    await gotoAgentHome(page, agent)
  })

  // Fire a proxy review bound to a fresh, test-owned account and wait for its card.
  async function triggerReview(
    page: Page,
    request: APIRequestContext,
    testInfo: TestInfo,
  ): Promise<{ accountId: string; review: TestPendingProxyReview }> {
    const accountId = `acct-${uniqueSuffix(testInfo)}`
    await sessionPage.sendMessage(`proxy review account_id=${accountId} ${uniqueSuffix(testInfo)}`)
    await waitForCurrentSessionId(page)
    const review = await waitForPendingProxyReview(request, agent, {
      xAgent: false,
      toolkit: 'slack',
      targetPath: 'api/chat.postMessage',
      matchedScope: 'chat:write',
    })
    // The parameterized account id flowed all the way through to the review.
    expect(review.accountId).toBe(accountId)
    await sessionPage.waitForProxyReviewRequestById(review.id, 35000)
    return { accountId, review }
  }

  async function getScopePolicies(request: APIRequestContext, accountId: string): Promise<ScopePolicy[]> {
    const res = await request.get(`/api/policies/scope/${accountId}`)
    expect(res.ok(), `get scope policies ${res.status()}`).toBeTruthy()
    const body = await res.json() as { policies: ScopePolicy[] }
    return body.policies
  }

  test('deny-with-reason denies once without persisting any policy', async ({ page, request }, testInfo) => {
    const { accountId, review } = await triggerReview(page, request, testInfo)

    // Deny chevron menu > free-text reason > submit — previously undriven.
    await sessionPage.denyWithReason('Not permitted during this test', review.id)

    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user', 0, 15000)

    // A one-time deny writes nothing to the scope-policy table.
    const policies = await getScopePolicies(request, accountId)
    expect(policies).toEqual([])
  })
})
