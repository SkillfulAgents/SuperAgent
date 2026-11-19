import { test, expect, type Page } from '@playwright/test'
import { SessionPage } from '../../pages/session.page'

/**
 * Live proof that an agent sets its own Linear app up in its browser, the way
 * it sets up a Slack bot.
 *
 * Nothing is mocked: a real container runs the real CLI against the real
 * model. The agent calls add_agent_integration for Linear, which creates the
 * installation and returns the prefilled Linear app creation link; the agent
 * opens it in its browser and, at Linear's login page, asks the user to log
 * in. Going further needs a real Linear account, so the probe declines there
 * and checks what the agent set up up to that point.
 *
 * Run through e2e/live/integration-setup/run.mjs, which seeds the data dir,
 * boots the host with the real container, and records the video.
 */

const APP_NAME = 'Support Triage'

/**
 * Human pacing for the recording. Every assertion still waits on real UI
 * state; these pauses only exist so the video is followable.
 */
async function beat(page: Page, ms = 1500) {
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- deliberate pacing for the demo recording, not a synchronization wait
  await page.waitForTimeout(ms)
}

test('agent starts its own Linear app setup and takes it to Linear in its browser', async ({ page, request }) => {
  const sessionPage = new SessionPage(page)

  // Created over the API so the recording opens on the agent's home page.
  const created = await request.post('/api/agents', {
    data: { name: 'Support Desk', description: 'Live integration setup probe' },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { slug } = (await created.json()) as { slug: string }

  await page.goto(`/agents/${slug}`)
  const homeInput = page.getByTestId('home-message-input')
  // The first page load compiles the renderer on a cold dev server.
  await expect(homeInput).toBeVisible({ timeout: 2 * 60_000 })
  await beat(page)

  const prompt =
    `Our team wants to delegate support issues to you in Linear. ` +
    `Set yourself up with your own Linear app named "${APP_NAME}". Don't ask me anything first.`
  await homeInput.click()
  await homeInput.pressSequentially(prompt, { delay: 8 })
  await beat(page, 800)
  await page.getByTestId('home-send-button').click()

  await expect(page).toHaveURL(/\/sessions\/[^/]+/, { timeout: 30_000 })
  const sessionId = page.url().match(/\/sessions\/([^/?#]+)/)![1]

  // ── The agent creates the installation and opens Linear in its browser,
  // where it needs the user to log in ─────────────────────────────────
  const browserInput = page.getByTestId('browser-input-request')
  await expect(browserInput).toBeVisible({ timeout: 5 * 60_000 })
  await expect(browserInput).toContainText(/Linear/i)
  await beat(page, 4000)

  // The installation exists, waiting for its app and authorization.
  const integrationsRes = await request.get(`/api/agent-integrations/agents/${slug}`)
  expect(integrationsRes.ok()).toBeTruthy()
  const integrations = (await integrationsRes.json()) as Array<{ id: string; provider: string; status: string }>
  const linear = integrations.find((i) => i.provider === 'linear')
  expect(linear?.status).toBe('disconnected')

  // ── Logging in needs a real Linear account: stop here ───────────────
  await browserInput.getByTestId('browser-input-decline-btn').click()
  await expect(browserInput).toBeHidden({ timeout: 30_000 })
  await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 2 * 60_000 })
  await beat(page, 3000)

  // The transcript shows the setup the agent ran: the installation with its
  // prefilled Linear app link, then that link opened in the browser.
  const transcriptRes = await request.get(`/api/agents/${slug}/sessions/${sessionId}/messages`)
  expect(transcriptRes.ok()).toBeTruthy()
  const transcript = (await transcriptRes.json()) as Array<{
    toolCalls?: Array<{ name: string; input: Record<string, unknown>; result?: unknown }>
  }>
  const calls = transcript.flatMap((m) => m.toolCalls ?? [])
  const add = calls.find((c) => c.name === 'mcp__chat__add_agent_integration')
  expect(add?.input.provider).toBe('linear')
  expect(JSON.stringify(add?.result)).toContain('linear.app/settings/api/applications/new')
  expect(JSON.stringify(add?.result)).toContain(`authorize_agent_integration with integration_id \\"${linear!.id}\\"`)
  const opened = calls.filter((c) => c.name.startsWith('mcp__browser__')).map((c) => JSON.stringify(c.input))
  expect(opened.some((input) => input.includes('linear.app/settings/api/applications/new'))).toBe(true)

  test.info().annotations.push(
    { type: 'session', description: `${slug}/${sessionId}` },
    { type: 'tool calls', description: calls.map((c) => c.name).join(' → ') },
  )
})
