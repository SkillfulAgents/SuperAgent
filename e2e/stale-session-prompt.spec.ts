/**
 * E2E tests for the stale-session surface (toast + popovers).
 *
 * Trigger: idle > 6 h  AND  context > 100 k tokens (AND logic). Detection is
 * continuous (not send-gated): the toast surfaces at rest, above the composer.
 *
 * Seeding mechanism (see e2e/helpers/stale-session.ts):
 *  - JSONL entry timestamps are rewritten to 7 h ago →  lastActivityAt is old
 *  - session-metadata.json lastUsage.inputTokens = 110 000  →  contextTokens > threshold
 *
 * Run:
 *   E2E_MOCK=true npx playwright test e2e/stale-session-prompt.spec.ts 2>&1 | tee /tmp/e2e-stale.txt
 */

import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from './pages/app.page'
import { SessionPage } from './pages/session.page'
import { createAgent, openAgentHome } from './helpers/agents'
import { seedStaleSession } from './helpers/stale-session'

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

type TestAgent = { slug: string; name: string }

/** Fetch the most-recently-created session ID for an agent via the API. */
async function getFirstSessionId(
  request: APIRequestContext,
  agentSlug: string,
): Promise<string> {
  const resp = await request.get(`/api/agents/${agentSlug}/sessions`)
  expect(resp.ok()).toBeTruthy()
  const sessions = (await resp.json()) as Array<{ id: string }>
  expect(sessions.length).toBeGreaterThan(0)
  return sessions[0].id
}

/**
 * Navigate to a specific session by clicking its sidebar item.
 *
 * Session sub-items live inside a Radix CollapsibleContent and are UNMOUNTED
 * while the agent row is collapsed — clicking one before expanding auto-waits
 * for an element that never attaches and hangs until the test times out. Wait
 * for the (collapsed-state) Expand chevron to render before clicking it.
 */
async function openSessionById(
  page: Page,
  agent: TestAgent,
  sessionId: string,
): Promise<void> {
  const agentLi = page
    .locator('li')
    .filter({ has: page.locator(`[data-testid="agent-item-${agent.slug}"]`) })
    .or(
      page
        .locator('li')
        .filter({ has: page.locator('[data-testid^="agent-item-"]', { hasText: agent.name }) }),
    )
    .first()

  const expandChevron = agentLi.locator('button[aria-label="Expand"]').first()
  await expandChevron.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
  if (await expandChevron.isVisible().catch(() => false)) {
    await expandChevron.click()
  }

  await page.locator(`[data-testid="session-item-${sessionId}"]`).click()
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 20000 })
}

/**
 * Standard setup: create an agent + send one message so the JSONL and
 * session-metadata files exist on disk.  Returns the agent + its session ID.
 */
async function setupWithSession(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
): Promise<{ agent: TestAgent; sessionId: string }> {
  const appPage = new AppPage(page)
  const sessionPage = new SessionPage(page)
  const agentName = `Stale ${label} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`

  const agent = await createAgent(request, agentName)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentHome(page, agent)

  // First message → creates the JSONL file + session-metadata entry on disk
  await sessionPage.sendMessage('Hello')
  await sessionPage.waitForResponse(30000)
  await sessionPage.waitForInputEnabled(15000)

  const sessionId = await getFirstSessionId(request, agent.slug)
  return { agent, sessionId }
}

/**
 * Seed the session stale, return to agent home (so navigating back forces a
 * fresh useSession fetch with the seeded data), then open it at rest and wait
 * for the seeded context to land in the UI.
 */
async function openStaleAtRest(
  page: Page,
  sessionPage: SessionPage,
  agent: TestAgent,
  sessionId: string,
): Promise<void> {
  await page.locator('[data-testid="agent-breadcrumb"]').click()
  await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

  seedStaleSession(agent.slug, sessionId)

  // "Context Usage" renders only once useSession has refetched with the seeded
  // lastUsage, so it doubles as a settle point before asserting on the toast.
  await openSessionById(page, agent, sessionId)
  await expect(page.getByText('Context Usage')).toBeVisible({ timeout: 20000 })
  await sessionPage.waitForInputEnabled(15000)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Stale Session Surface', () => {
  // -------------------------------------------------------------------------
  // Scenario 1 — the toast surfaces at rest on an idle + large conversation
  // -------------------------------------------------------------------------
  test('stale session: the toast appears at rest, no send required', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)
    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'Toast')

    await openStaleAtRest(page, sessionPage, agent, sessionId)

    const toast = page.locator('[data-testid="stale-toast"]')
    await expect(toast).toBeVisible({ timeout: 20000 })
    await expect(toast).toContainText('Start a new conversation?')
  })

  // -------------------------------------------------------------------------
  // Scenario 2 — Ignore hides the toast (local state, no persistence)
  // -------------------------------------------------------------------------
  test('stale session: Ignore hides the toast', async ({ page, request }, testInfo) => {
    const sessionPage = new SessionPage(page)
    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'Ignore')

    await openStaleAtRest(page, sessionPage, agent, sessionId)

    const toast = page.locator('[data-testid="stale-toast"]')
    await expect(toast).toBeVisible({ timeout: 20000 })

    await page.locator('[data-testid="stale-toast-ignore"]').click()
    await expect(toast).not.toBeVisible({ timeout: 15000 })
  })

  // -------------------------------------------------------------------------
  // Scenario 3 — the toast offers Ignore and New conversation
  // -------------------------------------------------------------------------
  test('stale session: the toast offers Ignore and New conversation', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)
    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'NewChat')

    await openStaleAtRest(page, sessionPage, agent, sessionId)
    await expect(page.locator('[data-testid="stale-toast"]')).toBeVisible({ timeout: 20000 })

    await expect(page.locator('[data-testid="stale-toast-ignore"]')).toBeVisible()
    const newChat = page.locator('[data-testid="stale-new-chat"]')
    await expect(newChat).toBeVisible()
    await expect(newChat).toContainText('New conversation')
  })

  // -------------------------------------------------------------------------
  // Scenario 4 — the Learn more popover shows the two teaching points
  // -------------------------------------------------------------------------
  test('stale session: Learn more popover shows the two teaching points', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)
    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'LearnMore')

    await openStaleAtRest(page, sessionPage, agent, sessionId)
    await expect(page.locator('[data-testid="stale-toast"]')).toBeVisible({ timeout: 20000 })

    await page.locator('[data-testid="stale-learn-more-trigger"]').click()

    const learnMore = page.locator('[data-testid="stale-learn-more-popover"]')
    await expect(learnMore).toBeVisible({ timeout: 15000 })
    await expect(learnMore).toContainText('Your agent can handle many conversations at once.')
    await expect(learnMore).toContainText('Agents re-read everything each time they reply.')
  })

  // -------------------------------------------------------------------------
  // Scenario 5 — "Start fresh" carries the composer into a new chat (no send)
  //
  // No session is created until the user actually sends. Start fresh snapshots the
  // composer (text + model + effort + files) and lands the user on the agent's
  // new-chat composer with it carried over, ready to edit — nothing is sent.
  // -------------------------------------------------------------------------
  test('stale session: Start fresh carries the typed draft into the new-chat composer without sending', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)
    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'Fresh')

    await openStaleAtRest(page, sessionPage, agent, sessionId)
    await expect(page.locator('[data-testid="stale-toast"]')).toBeVisible({ timeout: 20000 })

    // Type into the in-session composer, then start a new conversation.
    await page.locator('[data-testid="message-input"]').fill('A brand new conversation')

    await page.locator('[data-testid="stale-new-chat"]').click()

    // Lands on the agent's new-chat composer — no session created, nothing sent —
    // with the draft carried verbatim and ready to edit.
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="message-input"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="home-message-input"]')).toHaveValue('A brand new conversation')
  })

  // -------------------------------------------------------------------------
  // Scenario 6 — a plain send is never intercepted (detection is not send-gated)
  // -------------------------------------------------------------------------
  test('stale session: a plain send lands in the same conversation and is not intercepted', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)
    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'Send')

    await openStaleAtRest(page, sessionPage, agent, sessionId)
    await expect(page.locator('[data-testid="stale-toast"]')).toBeVisible({ timeout: 20000 })

    // Sending goes straight through to the current conversation — no gate, no modal.
    await sessionPage.sendMessage('Send into this one')
    await sessionPage.waitForUserMessageCount(2, 25000) // "Hello" + "Send into this one"
  })

  // -------------------------------------------------------------------------
  // Scenario 8 — Awaiting-input suppression
  //
  // When a session has a pending input request the message input is replaced by
  // the PendingRequestStack, so the toast slot is not in play and no toast fires.
  // The isAwaitingInput branch is exercised at unit level in
  // stale-session-trigger.test.ts.
  // -------------------------------------------------------------------------
  test('awaiting-input session: message input is hidden and no toast fires', async (
    { page, request },
    testInfo,
  ) => {
    const appPage = new AppPage(page)
    const sessionPage = new SessionPage(page)
    const agentName = `Stale AwaitInput ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`

    const agent = await createAgent(request, agentName)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentHome(page, agent)

    // 'ask secret' triggers the UserInputRequest scenario in MockContainerClient,
    // putting the session into awaiting_input state with a pending secret request
    await sessionPage.sendMessage('ask secret')
    await sessionPage.waitForSecretRequest('OPENAI_API_KEY', 15000)

    const sessionId = await getFirstSessionId(request, agent.slug)

    // Seed stale state on top of the awaiting-input session: it now satisfies
    // idle > 6 h AND context > 100 k tokens, but isAwaitingInput suppresses it.
    seedStaleSession(agent.slug, sessionId)

    // Reload — SSE reconnects and the server replays pending input requests.
    await page.reload()
    await appPage.waitForAgentsLoaded()
    await openSessionById(page, agent, sessionId)

    await expect(
      page.locator('[data-testid="secret-request"]').first(),
    ).toBeAttached({ timeout: 20000 })

    // The message input is NOT rendered (pending request stack takes its slot)
    await expect(page.locator('[data-testid="message-input"]')).not.toBeVisible()
    // And no stale toast is shown.
    await expect(page.locator('[data-testid="stale-toast"]')).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Scenario 9 — Fresh small session: no toast
  // -------------------------------------------------------------------------
  test('fresh small session: no toast appears', async ({ page, request }, testInfo) => {
    const appPage = new AppPage(page)
    const sessionPage = new SessionPage(page)
    const agentName = `Stale Fresh ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`

    const agent = await createAgent(request, agentName)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentHome(page, agent)

    // First message creates a fresh session — idle ≈ 0 ms, context ≈ 0 tokens
    await sessionPage.sendMessage('First message')
    await sessionPage.waitForResponse(30000)
    await sessionPage.waitForInputEnabled(15000)

    // Immediately send a second message — neither threshold is met
    await sessionPage.sendMessage('Second message right away')

    await sessionPage.waitForUserMessageCount(2, 25000)
    // No stale toast ever appeared (neither threshold met).
    await expect(page.locator('[data-testid="stale-toast"]')).not.toBeVisible()
  })
})
