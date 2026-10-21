import { test, expect, type Page } from '@playwright/test'
import { SessionPage } from '../../pages/session.page'

/**
 * Live proof that an agent asking for an integration only its owner may set
 * up parks on an owner setup card, and goes on with the owner's answer.
 *
 * Nothing is mocked: a real container runs the real CLI against the real
 * model. The agent calls add_agent_integration for Linear; the host answers
 * the container's call by opening the card; the owner opens the Linear setup
 * the agent prefilled, then declines with a reason, and the agent continues
 * the same turn with that reason. Finishing the setup itself needs a real
 * Linear app, so it is not part of the probe.
 *
 * Run through e2e/live/integration-setup/run.mjs, which seeds the data dir,
 * boots the host with the real container, and records the video.
 */

const SUGGESTED_NAME = 'Support Triage'
const DECLINE_REASON = 'Hold off for now, we will use the shared team bot.'

/**
 * Human pacing for the recording. Every assertion still waits on real UI
 * state; these pauses only exist so the video is followable.
 */
async function beat(page: Page, ms = 1500) {
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- deliberate pacing for the demo recording, not a synchronization wait
  await page.waitForTimeout(ms)
}

test('agent asks its owner for Linear, the owner opens the prefilled setup, then declines and the agent carries on', async ({ page, request }) => {
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
    `Get yourself your own Linear app named "${SUGGESTED_NAME}". Don't ask me anything first.`
  await homeInput.click()
  await homeInput.pressSequentially(prompt, { delay: 8 })
  await beat(page, 800)
  await page.getByTestId('home-send-button').click()

  await expect(page).toHaveURL(/\/sessions\/[^/]+/, { timeout: 30_000 })
  const sessionId = page.url().match(/\/sessions\/([^/?#]+)/)![1]

  // ── The agent asks; only the owner may set Linear up ────────────────
  const card = page.getByTestId('integration-setup-request')
  await expect(card).toBeVisible({ timeout: 4 * 60_000 })
  await expect(card).toContainText('Set up Linear for this agent?')
  await beat(page, 2500)

  // ── The owner opens Linear's own setup, prefilled by the agent ──────
  await card.getByTestId('integration-setup-open-btn').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Set up integration with Linear')
  await expect(dialog.getByLabel('Integration name')).toHaveValue(SUGGESTED_NAME)
  await beat(page, 3500)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(card).toBeVisible()
  await beat(page)

  // ── The owner declines with a reason; the agent hears it ────────────
  await card.getByTestId('integration-setup-decline-btn-chevron').click()
  const reason = page.getByPlaceholder('Reason for declining...')
  await expect(reason).toBeVisible()
  await reason.pressSequentially(DECLINE_REASON, { delay: 20 })
  await beat(page, 800)
  await reason.press('Enter')
  await expect(card).toBeHidden({ timeout: 30_000 })

  await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 4 * 60_000 })
  await beat(page, 3500)

  // The transcript holds the call and the owner's answer as its result.
  const transcriptRes = await request.get(`/api/agents/${slug}/sessions/${sessionId}/messages`)
  expect(transcriptRes.ok()).toBeTruthy()
  const transcript = (await transcriptRes.json()) as Array<{
    type: 'user' | 'assistant'
    toolCalls?: Array<{ name: string; input: Record<string, unknown>; result?: unknown; isError?: boolean }>
  }>
  const calls = transcript.flatMap((m) => m.toolCalls ?? [])
  const setup = calls.find((c) => c.name === 'mcp__chat__add_agent_integration')
  expect(setup?.input.provider).toBe('linear')
  expect(setup?.isError).toBe(true)
  expect(JSON.stringify(setup?.result)).toContain(DECLINE_REASON)

  test.info().annotations.push(
    { type: 'session', description: `${slug}/${sessionId}` },
    { type: 'tool calls', description: calls.map((c) => c.name).join(' → ') },
  )
})
