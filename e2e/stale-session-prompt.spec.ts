/**
 * E2E tests for the stale-session prompt.
 *
 * Trigger: idle > 6 h  AND  context > 100 k tokens (AND logic).
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
 * The chevron button is a SIBLING of [data-testid="agent-item-*"], not a
 * descendant — it sits inside the wrapping <li> next to the agent button.
 * We use .filter() to scope to the <li> before looking for the chevron.
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

  // Expand the session sub-list if the chevron is present (isOpen = false)
  const chevron = agentLi.locator('button[aria-label="Expand"]').first()
  if (await chevron.isVisible({ timeout: 1500 }).catch(() => false)) {
    await chevron.click()
  }

  await page.locator(`[data-testid="session-item-${sessionId}"]`).click()
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 10000 })
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
  await sessionPage.waitForResponse(15000)
  await sessionPage.waitForInputEnabled(10000)

  const sessionId = await getFirstSessionId(request, agent.slug)
  return { agent, sessionId }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Stale Session Prompt', () => {
  // -------------------------------------------------------------------------
  // Scenario 1 — "Send here anyway" sends the message and dismissal persists
  // -------------------------------------------------------------------------
  test('stale session: "Send here anyway" delivers the message and dismissal persists', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)

    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'SendHere')

    // Go back to agent home so navigating to the session triggers a fresh useSession fetch
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Seed: idle > 6 h AND context > 100 k tokens
    seedStaleSession(agent.slug, sessionId)

    // Navigate to the session — useSession background-refetches with seeded data.
    // "Context Usage" is only rendered when contextPercent != null (i.e. when
    // contextUsage is non-null), which means useSession has completed its refetch
    // with the seeded lastUsage and React has re-rendered.  Wait for it before
    // submitting to avoid a race between cached (unseeded) state and fresh data.
    await openSessionById(page, agent, sessionId)
    await expect(page.getByText('Context Usage')).toBeVisible({ timeout: 20000 })
    await sessionPage.waitForInputEnabled(5000)

    // --- First send: stale prompt must open ---
    await page.locator('[data-testid="message-input"]').fill('First message')
    await page.locator('[data-testid="send-button"]').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog).toContainText('Large context')

    // Click "Send here anyway"
    await dialog.getByRole('button', { name: /send here anyway/i }).click()

    // Dialog closes and the message lands in the same session
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await sessionPage.waitForUserMessageCount(2, 10000)   // "Hello" + "First message"

    // Wait for the mock response and for the dismiss PATCH to be reflected
    await sessionPage.waitForResponse(15000)
    await sessionPage.waitForInputEnabled(10000)

    // Poll the API to confirm stalePromptDismissed was persisted before second send
    await expect.poll(async () => {
      const resp = await request.get(`/api/agents/${agent.slug}/sessions/${sessionId}`)
      const s = (await resp.json()) as { stalePromptDismissed?: boolean }
      return s.stalePromptDismissed
    }, { timeout: 5000 }).toBe(true)

    // --- Second send: stale prompt must NOT re-open (dismissal persisted) ---
    await page.locator('[data-testid="message-input"]').fill('Second message')
    await page.locator('[data-testid="send-button"]').click()

    // The second message sends straight through (proves the prompt did NOT intercept).
    await sessionPage.waitForUserMessageCount(3, 10000)
    // And the stale prompt never re-opened (dismissal persisted).
    await expect(dialog).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Scenario 1b — Clicking outside cancels (true cancel, not a dismissal)
  //
  // Unlike "Send here anyway", a backdrop click must NOT set the dismissal
  // flag: it restores the typed draft to the input and re-prompts on the next
  // send because the session is still stale.
  // -------------------------------------------------------------------------
  test('stale session: clicking outside the prompt cancels, restores the draft, and re-prompts on next send', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)

    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'Cancel')

    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    seedStaleSession(agent.slug, sessionId)

    await openSessionById(page, agent, sessionId)
    await expect(page.getByText('Context Usage')).toBeVisible({ timeout: 20000 })
    await sessionPage.waitForInputEnabled(5000)

    // Send: the stale prompt opens
    await page.locator('[data-testid="message-input"]').fill('Draft to keep')
    await page.locator('[data-testid="send-button"]').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog).toContainText('Large context')

    // Click the backdrop (top-left corner, outside the centered content)
    await page.mouse.click(10, 10)

    // Dialog closes, and the typed draft is restored to the input
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="message-input"]')).toHaveValue('Draft to keep')

    // No dismissal flag was persisted (true cancel, not "send here anyway")
    const resp = await request.get(`/api/agents/${agent.slug}/sessions/${sessionId}`)
    const s = (await resp.json()) as { stalePromptDismissed?: boolean }
    expect(s.stalePromptDismissed ?? false).toBe(false)

    // Sending again re-opens the prompt (session is still stale)
    await page.locator('[data-testid="send-button"]').click()
    await expect(dialog).toBeVisible({ timeout: 5000 })
  })

  // -------------------------------------------------------------------------
  // Scenario 1c — "Start a new topic" delivers the message to a fresh session
  // and renders it immediately (optimistic copy seeded on navigation).
  // -------------------------------------------------------------------------
  test('stale session: "Start a new topic" creates a fresh session and shows the typed message', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)

    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'NewTopic')

    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    seedStaleSession(agent.slug, sessionId)

    await openSessionById(page, agent, sessionId)
    await expect(page.getByText('Context Usage')).toBeVisible({ timeout: 20000 })
    await sessionPage.waitForInputEnabled(5000)

    await page.locator('[data-testid="message-input"]').fill('A brand new topic')
    await page.locator('[data-testid="send-button"]').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Start a new topic — creates a fresh session, sends the typed message verbatim
    await dialog.getByRole('button', { name: /start a new topic/i }).click()

    // Prompt closes and the typed message is rendered in the new session
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
    await expect(
      page.locator('[data-testid="message-list"]').getByText('A brand new topic'),
    ).toBeVisible({ timeout: 8000 })
  })

  // -------------------------------------------------------------------------
  // Scenario 2 — "Continue from a summary"
  //
  // NOTE: getConfiguredLlmClient() throws ("LLM API key not configured") in
  // E2E_MOCK mode because no API key is set.  The branch endpoint therefore
  // returns 502 and the frontend surfaces "Couldn't summarize right now".
  //
  // Full assertion (navigation to new session + carried-context card) is
  // deferred to unit/integration tests in session-summary-service — those can
  // stub getConfiguredLlmClient() and verify the complete happy path.
  //
  // This test asserts the strongest observable E2E behaviour: the summarising
  // loading state appears, the error is surfaced within the modal, and the
  // dialog stays open so the user can retry or dismiss.
  // -------------------------------------------------------------------------
  test('stale session: "Continue from a summary" enters summarising state then shows error (LLM unconfigured in E2E)', async (
    { page, request },
    testInfo,
  ) => {
    const sessionPage = new SessionPage(page)

    const { agent, sessionId } = await setupWithSession(page, request, testInfo, 'Branch')

    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    seedStaleSession(agent.slug, sessionId)
    await openSessionById(page, agent, sessionId)
    // Same race-guard as scenario 1: wait for seeded lastUsage to appear in UI
    await expect(page.getByText('Context Usage')).toBeVisible({ timeout: 20000 })
    await sessionPage.waitForInputEnabled(5000)

    await page.locator('[data-testid="message-input"]').fill('Continue this conversation')
    await page.locator('[data-testid="send-button"]').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Click "Continue from a summary" (first option in the dialog)
    await dialog.getByRole('button', { name: /continue from a summary/i }).click()

    // Summarising / loading state appears briefly
    await expect(dialog.getByText(/carrying over context/i)).toBeVisible({ timeout: 5000 })

    // Error appears because the LLM is not configured in E2E mock mode
    await expect(dialog.getByText(/couldn't summarize right now/i)).toBeVisible({ timeout: 15000 })

    // Button now reads "Retry summary" and dialog stays open for the user to retry or close
    await expect(dialog.getByRole('button', { name: /retry summary/i })).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Scenario 3 — Awaiting-input suppression
  //
  // evaluateStalePrompt checks isAwaitingInput as a safety net. At the UI level
  // the SessionChatColumn replaces the MessageInput with the PendingRequestStack
  // entirely when pendingRequestCount > 0, so the stale prompt submit path is
  // not reachable for the user at all.
  //
  // This test asserts the observable UI behaviour: when a session has a pending
  // input request, the message input is hidden and no stale prompt can fire.
  //
  // The isAwaitingInput branch inside evaluateStalePrompt is exercised at unit
  // level in stale-session-trigger.test.ts.
  // -------------------------------------------------------------------------
  test('awaiting-input session: message input is hidden and stale prompt cannot fire', async (
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

    // Seed stale state on top of the awaiting-input session.
    // After this, the session satisfies idle > 6 h AND context > 100 k tokens,
    // but isAwaitingInput = true in the stream suppresses the stale prompt.
    seedStaleSession(agent.slug, sessionId)

    // Reload — SSE reconnects and the server replays pending input requests.
    // Navigate directly to the session via the sidebar (no openAgentHome step:
    // landing on "home" view doesn't auto-expand the session list, so
    // openSessionById would never find the session-item without first expanding).
    await page.reload()
    await appPage.waitForAgentsLoaded()
    await openSessionById(page, agent, sessionId)

    // The pending secret request is shown (attached to the DOM)
    await expect(
      page.locator('[data-testid="secret-request"]').first(),
    ).toBeAttached({ timeout: 10000 })

    // The message input is NOT rendered (pending request stack takes its slot)
    await expect(page.locator('[data-testid="message-input"]')).not.toBeVisible()

    // No stale prompt dialog is open
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Scenario 4 — Fresh small session: no prompt
  // -------------------------------------------------------------------------
  test('fresh small session: sending a message does not open the stale prompt', async (
    { page, request },
    testInfo,
  ) => {
    const appPage = new AppPage(page)
    const sessionPage = new SessionPage(page)
    const agentName = `Stale Fresh ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`

    const agent = await createAgent(request, agentName)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentHome(page, agent)

    // First message creates a fresh session — idle ≈ 0 ms, context ≈ 0 tokens
    await sessionPage.sendMessage('First message')
    await sessionPage.waitForResponse(15000)
    await sessionPage.waitForInputEnabled(10000)

    // Immediately send a second message — neither threshold is met
    await sessionPage.sendMessage('Second message right away')

    // The message sends straight through (proves the prompt did NOT intercept).
    await sessionPage.waitForUserMessageCount(2, 10000)
    // And no stale prompt dialog ever appeared (neither threshold met).
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })
})
