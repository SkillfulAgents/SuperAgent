import { test, expect, type Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const E2E_DATA_DIR = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')
const RECORDER_FILE = path.join(E2E_DATA_DIR, '.e2e-mock-recorder.jsonl')

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  sessionId?: string
  content?: string
  autopilot?: boolean
  timestamp: string
}

function readRecords(): MockRecord[] {
  if (!fs.existsSync(RECORDER_FILE)) return []
  const lines = fs.readFileSync(RECORDER_FILE, 'utf-8').trim().split('\n').filter(Boolean)
  return lines.map((l) => JSON.parse(l) as MockRecord)
}

// Recorder file is shared across workers — always filter by test-unique content.
async function waitForRecord(
  predicate: (r: MockRecord) => boolean,
  timeoutMs = 10000
): Promise<MockRecord> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readRecords().find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for matching record. Records seen: ${JSON.stringify(readRecords(), null, 2)}`)
}

async function expectAutopilotState(
  page: Page,
  agentSlug: string,
  sessionId: string,
  state: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/agents/${agentSlug}/sessions/${sessionId}`)
        if (!res.ok()) return `http-${res.status()}`
        const body = (await res.json()) as { autopilot?: { state?: string } }
        return body.autopilot?.state ?? 'off'
      },
      { timeout: 10000 }
    )
    .toBe(state)
}

test.describe('Autopilot toggle', () => {
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

    testAgentName = `Autopilot Agent ${testInfo.workerIndex}-${Date.now()}`
  })

  test('flipping the switch sends autopilot=true and moves the session to requested', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const message = `Autopilot on ${tag}`

    await agentPage.createAgent(testAgentName)
    await agentPage.expandAgent(testAgentName)
    await page.locator('[data-testid^="session-item-"]').first().click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    const toggle = page.locator('[data-testid="autopilot-toggle"]')
    const switchButton = toggle.locator('button[role="switch"]')
    await expect(toggle).toBeVisible()
    await expect(switchButton).toHaveAttribute('data-state', 'unchecked')

    await switchButton.click()
    await expect(switchButton).toHaveAttribute('data-state', 'checked')

    await sessionPage.sendMessage(message)

    const record = await waitForRecord((r) => r.type === 'sendMessage' && r.content === message)
    expect(record.autopilot).toBe(true)
    await expectAutopilotState(page, record.agentSlug, record.sessionId!, 'requested')

    // The requested state survives a reload — the switch seeds from session
    // metadata, not local component state.
    await page.reload()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="autopilot-toggle"] button[role="switch"]')
    ).toHaveAttribute('data-state', 'checked')
  })

  test('flipping the switch off sends an explicit disengage', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const onMessage = `Autopilot first ${tag}`
    const offMessage = `Autopilot off ${tag}`

    await agentPage.createAgent(testAgentName)
    await agentPage.expandAgent(testAgentName)
    await page.locator('[data-testid^="session-item-"]').first().click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    const switchButton = page.locator('[data-testid="autopilot-toggle"] button[role="switch"]')
    await switchButton.click()
    await sessionPage.sendMessage(onMessage)
    const onRecord = await waitForRecord((r) => r.type === 'sendMessage' && r.content === onMessage)
    expect(onRecord.autopilot).toBe(true)
    await expectAutopilotState(page, onRecord.agentSlug, onRecord.sessionId!, 'requested')

    // Wait for the turn to settle so the off-message starts a fresh turn and
    // the state assertion below isn't racing the send. (Queued sends DO carry
    // the autopilot flag — only model/effort/speed are stripped mid-turn.)
    await expect(switchButton).toHaveAttribute('data-state', 'checked')
    await expect(sessionPage.getActivityIndicator()).toBeHidden({ timeout: 15000 })

    await switchButton.click()
    await expect(switchButton).toHaveAttribute('data-state', 'unchecked')
    await sessionPage.sendMessage(offMessage)

    const offRecord = await waitForRecord((r) => r.type === 'sendMessage' && r.content === offMessage)
    expect(offRecord.autopilot).toBe(false)
    await expectAutopilotState(page, offRecord.agentSlug, offRecord.sessionId!, 'off')
  })

  test('engaged session renders the toggle on, batched approval decisions, and the watchdog card', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const message = `Autopilot engage ${tag}`

    await agentPage.createAgent(testAgentName)
    await agentPage.expandAgent(testAgentName)
    await page.locator('[data-testid^="session-item-"]').first().click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()
    await sessionPage.sendMessage(message)
    const record = await waitForRecord((r) => r.type === 'sendMessage' && r.content === message)
    const { agentSlug, sessionId } = record as Required<Pick<MockRecord, 'agentSlug' | 'sessionId'>> & MockRecord
    await expect(sessionPage.getActivityIndicator()).toBeHidden({ timeout: 15000 })

    // Seed the engaged lifecycle the way the host would have written it: the
    // metadata block the watchdog/composer read, plus the transcript cards the
    // approval reviewer and watchdog append (3 consecutive approvals — batched
    // into one row — and a done verdict).
    const workspaceDir = path.join(E2E_DATA_DIR, 'agents', agentSlug, 'workspace')
    const metadataPath = path.join(workspaceDir, 'session-metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, Record<string, unknown>>
    metadata[sessionId] = {
      ...metadata[sessionId],
      autopilot: {
        state: 'engaged',
        goal: { goal: `Finish task ${tag}`, success_criteria: ['Everything works'] },
        iteration: 1,
      },
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))

    const jsonlPath = path.join(workspaceDir, '.claude', 'projects', '-workspace', `${sessionId}.jsonl`)
    const reviewEntry = (uuid: string, review: Record<string, unknown>) =>
      JSON.stringify({
        uuid: `${uuid}-${tag}`,
        type: 'system',
        subtype: 'autopilot_review',
        content: JSON.stringify(review),
        isMeta: false,
        timestamp: new Date().toISOString(),
      })
    fs.appendFileSync(
      jsonlPath,
      [
        reviewEntry('ap-1', { verdict: 'approved', reasoning: 'Within the delegated scope.', action: 'API request: GET https://gmail.test/a' }),
        reviewEntry('ap-2', { verdict: 'approved', reasoning: 'Within the delegated scope.', action: 'API request: GET https://gmail.test/b' }),
        reviewEntry('ap-3', { verdict: 'denied', reasoning: 'Recipient never mentioned.', action: 'API request: POST https://gmail.test/send' }),
        reviewEntry('done', { verdict: 'done', reasoning: 'All success criteria satisfied.', iteration: 1, maxIterations: 10 }),
      ].join('\n') + '\n'
    )

    await page.reload()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    // The composer follows the server's engaged state.
    await expect(
      page.locator('[data-testid="autopilot-toggle"] button[role="switch"]')
    ).toHaveAttribute('data-state', 'checked')

    // The three consecutive decisions batch into ONE collapsed row…
    const group = page.locator('[data-testid="autopilot-approval-group"]')
    await expect(group).toHaveCount(1)
    await expect(group).toContainText('Autopilot reviewed 3 requests (1 denied)')
    // …whose reasons only show after expanding.
    await expect(group).not.toContainText('Recipient never mentioned.')
    await group.locator('button[aria-expanded]').click()
    await expect(group).toContainText('API request: POST https://gmail.test/send')
    await expect(group).toContainText('Recipient never mentioned.')

    // The watchdog verdict renders as its own card.
    const reviewCard = page.locator('[data-testid="autopilot-review-item"]')
    await expect(reviewCard).toHaveCount(1)
    await expect(reviewCard).toContainText('Autopilot complete')
    await expect(reviewCard).toContainText('review 1/10')
  })
})
