import { test, expect, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { SessionPage } from '../../pages/session.page'
import { startMockOAuthMcp, type MockOAuthMcp } from './mock-oauth-mcp'

/**
 * Live proof that an MCP server requested mid-turn is hot-added to the running
 * query — the agent carries on in the SAME turn, with no restart, no "Stopped"
 * marker and no [SYSTEM] continuation message.
 *
 * Nothing is mocked on the agent side: a real container runs the real CLI
 * against the real model. The only stand-in is the MCP server itself, which
 * is a local OAuth-protected server so the flow includes the human step —
 * the person signs in on the server's own login page in the OAuth popup.
 *
 * Run through e2e/live/mcp-hot-add/run.mjs, which seeds the data dir, boots
 * the host with the real container, and records the video.
 */
test.describe.configure({ mode: 'serial' })

let mock: MockOAuthMcp

test.beforeAll(async () => {
  mock = await startMockOAuthMcp()
})

test.afterAll(async () => {
  await mock?.close()
})

/**
 * Human pacing for the recording — long enough to read, short enough to
 * watch. Every assertion in the spec still waits on real UI state; these
 * pauses only exist so the video is followable.
 */
async function beat(page: Page, ms = 1500) {
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- deliberate pacing for the demo recording, not a synchronization wait
  await page.waitForTimeout(ms)
}

test('agent requests an OAuth MCP, the user signs in, and the agent uses its tools in the same turn', async ({ page, request }) => {
  // Wall-clock marks for compose-video.mjs, which lays the popup's recording
  // over the main page's recording at the moment it opened.
  const timing: Record<string, number> = { testStartedAt: Date.now() }
  const sessionPage = new SessionPage(page)
  const agentName = `Rocket Ops ${Date.now().toString(36)}`

  // The agent is created over the API so the recording opens on its home page
  // rather than on the create-agent chrome.
  const created = await request.post('/api/agents', {
    data: { name: agentName, description: 'Live MCP hot-add probe' },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { slug } = (await created.json()) as { slug: string }

  await page.goto(`/agents/${slug}`)
  const homeInput = page.getByTestId('home-message-input')
  await expect(homeInput).toBeVisible({ timeout: 30_000 })
  await beat(page)

  const prompt =
    `Please get today's launch authorization code from our Rocket Ops mission board. ` +
    `It is an MCP server at ${mock.mcpUrl} that uses OAuth. ` +
    `Request access to it if you don't have it yet, then tell me the code.`
  await homeInput.click()
  await homeInput.pressSequentially(prompt, { delay: 8 })
  await beat(page, 800)
  await page.getByTestId('home-send-button').click()

  await expect(sessionPage.getMessageList()).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/sessions\/[^/]+/, { timeout: 30_000 })
  const sessionId = page.url().match(/\/sessions\/([^/?#]+)/)![1]

  // ── The agent asks for the server ──────────────────────────────────
  const card = page.getByTestId('remote-mcp-request')
  await expect(card).toBeVisible({ timeout: 4 * 60_000 })
  await expect(card).toContainText(mock.mcpUrl)
  await beat(page, 2000)

  // ── The user connects: OAuth popup → the server's own login page ──
  const popupPromise = page.waitForEvent('popup')
  await card.getByRole('button', { name: 'Connect', exact: true }).click()
  const popup = await popupPromise
  timing.popupOpenedAt = Date.now()
  await expect(popup.getByTestId('login-username')).toBeVisible({ timeout: 30_000 })
  await expect(popup).toHaveTitle(/Rocket Ops/)
  await beat(popup, 1200)
  await popup.getByTestId('login-username').pressSequentially(mock.credentials.username, { delay: 40 })
  await popup.getByTestId('login-password').pressSequentially(mock.credentials.password, { delay: 40 })
  await beat(popup, 600)
  await popup.getByTestId('login-submit').click()

  // The callback page hands the result back to the card, which now offers to
  // grant the freshly connected server to the agent.
  const allowButton = card.getByRole('button', { name: /Allow Access/ })
  await expect(allowButton).toBeVisible({ timeout: 60_000 })
  timing.popupDoneAt = Date.now()
  expect(mock.tokensIssued).toHaveLength(1)
  await beat(page, 1500)
  await allowButton.click()
  await expect(card).not.toBeVisible({ timeout: 30_000 })

  // ── The agent carries on in the same turn and uses the new tool ───
  // A freshly connected server's tools default to the "review" policy, so
  // the agent's first call through the host proxy parks for one more click.
  // That the card appears at all is the proof: the call was made in the
  // same turn, seconds after the grant, with no restart in between.
  await sessionPage.waitForProxyReviewRequest(4 * 60_000)
  await expect(sessionPage.getProxyReviewRequests().first()).toContainText('get_launch_code')
  expect(mock.toolCalls).toHaveLength(0)
  await beat(page, 2000)
  await sessionPage.allowProxyReview()

  const answer = sessionPage.getAssistantMessages().filter({ hasText: 'RKT-4242-ORBIT' })
  await expect(answer).toBeVisible({ timeout: 4 * 60_000 })
  await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 60_000 })
  await beat(page, 3000)

  // The tool call reached the mock through the host proxy, carrying the token
  // the login just minted — and only after the OAuth dance completed.
  const launchCalls = mock.toolCalls.filter((c) => c.name === 'get_launch_code')
  expect(launchCalls.length).toBeGreaterThanOrEqual(1)
  expect(launchCalls[0].bearer).toBe(mock.tokensIssued[0])
  const order = ['register:', 'login:ok', 'token:issued', 'mcp:initialize:ok', 'mcp:tools/call:get_launch_code']
    .map((prefix) => mock.events.findIndex((e) => e.startsWith(prefix)))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)

  // ── No restart artefacts anywhere ──────────────────────────────────
  await expect(sessionPage.getInterruptMarkers()).toHaveCount(0)
  await expect(page.getByText('No response requested.')).toHaveCount(0)
  await expect(page.getByText(/has been fully registered/)).toHaveCount(0)

  // The persisted transcript agrees: one human message, no interrupt marker,
  // no [SYSTEM] continuation — both tool calls happened in that single turn.
  const transcriptRes = await request.get(`/api/agents/${slug}/sessions/${sessionId}/messages`)
  expect(transcriptRes.ok()).toBeTruthy()
  // ApiMessage shape: the host serves the transcript verbatim — hidden kinds
  // ([SYSTEM] continuations, interrupt markers) are filtered in the renderer,
  // so here they would still show up as user entries if they existed.
  const transcript = (await transcriptRes.json()) as Array<{
    type: 'user' | 'assistant'
    content: { text: string }
    toolCalls: Array<{ name: string }>
  }>
  const userTexts = transcript.filter((m) => m.type === 'user').map((m) => m.content.text)
  expect(userTexts).toHaveLength(1)
  expect(userTexts[0]).toContain('Rocket Ops mission board')

  const toolNames = transcript
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.toolCalls.map((t) => t.name))
  expect(toolNames).toContain('mcp__user-input__request_remote_mcp')
  expect(toolNames).toContain('mcp__rocket_ops__get_launch_code')

  test.info().annotations.push(
    { type: 'session', description: `${slug}/${sessionId}` },
    { type: 'tool calls', description: toolNames.join(' → ') },
  )
  timing.endedAt = Date.now()
  // Playwright creates the output dir lazily, on the first attachment.
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(path.join(test.info().outputDir, 'timing.json'), JSON.stringify(timing, null, 2))
})
