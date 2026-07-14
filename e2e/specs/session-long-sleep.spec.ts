import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

function getCurrentAgentSlug(page: Page) {
  const match = page.url().match(/\/agents\/([^/?#]+)/)
  expect(match).toBeTruthy()
  return match![1]
}

function getCurrentSessionId(page: Page) {
  const match = page.url().match(/\/sessions\/([^/?#]+)/)
  expect(match).toBeTruthy()
  return match![1]
}

interface SessionWithWake {
  id: string
  pendingWakeAt?: string
  pendingWakeTaskId?: string
  pendingWakeNote?: string
}

async function waitForPendingWake(
  request: APIRequestContext,
  agentSlug: string,
  sessionId: string
): Promise<SessionWithWake> {
  let session: SessionWithWake | undefined

  await expect.poll(async () => {
    const response = await request.get(`/api/agents/${agentSlug}/sessions`)
    if (!response.ok()) return false
    const sessions = (await response.json()) as SessionWithWake[]
    session = sessions.find((s) => s.id === sessionId)
    return Boolean(session?.pendingWakeTaskId)
  }, { timeout: 20000 }).toBe(true)

  return session!
}

test.describe('Session long sleep (schedule_resume)', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  async function scheduleResumeInNewSession(page: Page) {
    const agentName = `Sleep Agent ${Date.now()}`
    await agentPage.createAgent(agentName, { waitForSidebarName: false })

    await sessionPage.sendMessage('schedule resume until the review is approved')
    await sessionPage.expectToolCall('mcp__user-input__schedule_resume', 15000)

    const agentSlug = getCurrentAgentSlug(page)
    const sessionId = getCurrentSessionId(page)
    return { agentSlug, sessionId }
  }

  test('schedule_resume creates a pending wake with banner and sidebar badge', async ({ page, request }) => {
    const { agentSlug, sessionId } = await scheduleResumeInNewSession(page)

    // A real wake row is persisted, targeting THIS session
    const session = await waitForPendingWake(request, agentSlug, sessionId)
    expect(session.pendingWakeNote).toBe('Check whether the review has been approved')
    expect(new Date(session.pendingWakeAt!).getTime()).toBeGreaterThan(Date.now())

    // The auto-resume banner shows above the composer with the note + actions
    const banner = page.locator('[data-testid="pending-wake-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })
    await expect(banner).toContainText('auto-resume')
    await expect(banner).toContainText('Check whether the review has been approved')

    // The sidebar session row shows the pending-wake (moon) indicator
    await expect(
      page.locator(`[data-testid="session-pending-wake-${sessionId}"]`)
    ).toBeVisible({ timeout: 15000 })

    // Wakes are session-scoped: they must NOT appear in the agent-level
    // scheduled tasks (home triggers) list
    const tasksResponse = await request.get(`/api/agents/${agentSlug}/scheduled-tasks`)
    expect(tasksResponse.ok()).toBe(true)
    const tasks = (await tasksResponse.json()) as Array<{ id: string }>
    expect(tasks.find((t) => t.id === session.pendingWakeTaskId)).toBeUndefined()
  })

  test('Wake now resumes the session and clears the wake', async ({ page, request }) => {
    const { agentSlug, sessionId } = await scheduleResumeInNewSession(page)
    const session = await waitForPendingWake(request, agentSlug, sessionId)

    const banner = page.locator('[data-testid="pending-wake-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="pending-wake-wake-now"]').click()

    // The wake task is executed against the SAME session (no new session)
    await expect.poll(async () => {
      const res = await request.get(`/api/scheduled-tasks/${session.pendingWakeTaskId}`)
      if (!res.ok()) return null
      const task = (await res.json()) as { status: string; lastSessionId?: string }
      return task.status
    }, { timeout: 15000 }).toBe('executed')

    const taskRes = await request.get(`/api/scheduled-tasks/${session.pendingWakeTaskId}`)
    const task = (await taskRes.json()) as { lastSessionId?: string }
    expect(task.lastSessionId).toBe(sessionId)

    // Banner clears once the wake is gone
    await expect(banner).not.toBeVisible({ timeout: 15000 })

    // The wake message lands in this session as a system-prefixed turn and the
    // mock agent responds — the transcript grows in place.
    await expect(sessionPage.getAssistantMessages().nth(1)).toBeVisible({ timeout: 15000 })
  })

  test('Cancel clears the pending wake without resuming', async ({ page, request }) => {
    const { agentSlug, sessionId } = await scheduleResumeInNewSession(page)
    const session = await waitForPendingWake(request, agentSlug, sessionId)

    const banner = page.locator('[data-testid="pending-wake-banner"]')
    await expect(banner).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="pending-wake-cancel"]').click()

    await expect.poll(async () => {
      const res = await request.get(`/api/scheduled-tasks/${session.pendingWakeTaskId}`)
      if (!res.ok()) return null
      const task = (await res.json()) as { status: string }
      return task.status
    }, { timeout: 15000 }).toBe('cancelled')

    await expect(banner).not.toBeVisible({ timeout: 15000 })

    // No wake left on the session in the list API
    const response = await request.get(`/api/agents/${agentSlug}/sessions`)
    const sessions = (await response.json()) as SessionWithWake[]
    const updated = sessions.find((s) => s.id === sessionId)
    expect(updated?.pendingWakeTaskId).toBeUndefined()
  })
})
