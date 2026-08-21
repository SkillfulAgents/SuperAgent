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
 * Proxy-review policy PERSISTENCE — the security contract behind every "always"
 * choice on a review card. proxy-review.spec already clicks Allow / Deny /
 * always-allow-scope / always-allow-label, but never checks whether any "always"
 * decision actually wrote a policy. An always-deny that silently fails to persist
 * means dangerous requests keep flowing with no visible sign anything is wrong,
 * so these tests drive each card affordance and then assert the row that landed
 * (or, for the one-time paths, that nothing landed) in /api/policies/scope.
 *
 * The three previously-undriven affordances are covered here: always-deny-scope
 * (Deny chevron menu), always-allow-all (account-wide '*'), and deny-with-reason
 * (the free-text one-time deny).
 *
 * Each test drives its review against its OWN connected account via the
 * `account_id=<id>` scenario token (a harness addition in this batch):
 * apiScopePolicies is keyed by (accountId, scope), so without a per-test account
 * the persisted rows would collide across the 6 parallel workers.
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

  async function expectPersistedPolicy(
    request: APIRequestContext,
    accountId: string,
    scope: string,
    decision: string,
  ) {
    await expect.poll(async () => {
      const policies = await getScopePolicies(request, accountId)
      return policies.some((p) => p.scope === scope && p.decision === decision)
    }, { timeout: 10000 }).toBe(true)
  }

  test('always-allow for a scope persists an allow policy for that scope', async ({ page, request }, testInfo) => {
    const { accountId, review } = await triggerReview(page, request, testInfo)

    await sessionPage.alwaysAllowScope('chat:write', review.id)

    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)
    // The contract: the choice actually wrote the scope policy, not just resolved the card.
    await expectPersistedPolicy(request, accountId, 'chat:write', 'allow')

    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })

  test('always-deny for a scope persists a block policy for that scope', async ({ page, request }, testInfo) => {
    const { accountId, review } = await triggerReview(page, request, testInfo)

    // Deny chevron menu > "Always deny chat:write" — previously undriven.
    await sessionPage.alwaysDenyScope('chat:write', review.id)

    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)
    // A denied "always" decision persists as the 'block' decision.
    await expectPersistedPolicy(request, accountId, 'chat:write', 'block')

    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user', 0, 15000)
  })

  test('always-allow-all persists an account-wide allow default', async ({ page, request }, testInfo) => {
    const { accountId, review } = await triggerReview(page, request, testInfo)

    // "Always allow all Slack requests" > the account-wide '*' sentinel — previously undriven.
    await sessionPage.alwaysAllowAll(review.id)

    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)
    await expectPersistedPolicy(request, accountId, '*', 'allow')

    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })

  test('always-allow the minimal risk group persists the label-default sentinel', async ({ page, request }, testInfo) => {
    const { accountId, review } = await triggerReview(page, request, testInfo)

    // chat:write is a "write"-labelled scope, so the minimal risk group offered is "write".
    await sessionPage.alwaysAllowLabelGroup('write', review.id)

    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)
    // Persisted as the '*write' label sentinel, not the raw scope.
    await expectPersistedPolicy(request, accountId, '*write', 'allow')

    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('approved by user', 0, 15000)
  })

  test('deny-with-reason denies once without persisting any policy', async ({ page, request }, testInfo) => {
    const { accountId, review } = await triggerReview(page, request, testInfo)

    // Deny chevron menu > free-text reason > submit — previously undriven.
    await sessionPage.denyWithReason('Not permitted during this test', review.id)

    await expect(sessionPage.getProxyReviewRequests(review.id)).toHaveCount(0, { timeout: 10000 })
    await expectPendingProxyReviewResolved(request, agent, review)
    await sessionPage.waitForInputEnabled(15000)
    await sessionPage.expectAssistantMessage('denied by user', 0, 15000)

    // A one-time deny is NOT an "always" decision: unlike always-deny above, it
    // writes nothing to the scope-policy table.
    const policies = await getScopePolicies(request, accountId)
    expect(policies).toEqual([])
  })
})
