import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { mockRecorder } from '../helpers/mock-recorder'
import { timestampedUploadNamePattern } from '../helpers/upload-filename'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  content?: string
  initialMessage?: string
  model?: string
}

const recorder = mockRecorder<MockRecord>()
const HAIKU = 'claude-haiku-4-5'

function attachmentPreview(page: Page, fileName: string) {
  return page.getByTestId('attachment-preview').filter({ hasText: fileName })
}

/** Open the composer's model picker, pick a concrete version, and close it again. */
async function pickModel(page: Page, modelId: string) {
  await page.getByTestId('composer-options-trigger').click()
  const version = page.getByTestId(`model-pinned-${modelId}`)
  await version.waitFor({ state: 'visible' })
  await version.click()
  await page.keyboard.press('Escape')
}

/**
 * What is unsent in a composer comes back when the composer does (SUP-1142).
 *
 * Opening another page unmounts the composer. Its text always came back; a
 * file attached with it and a model picked for it did not, because those were
 * only that mounted composer's state. All three are one draft now, so this
 * pins the whole of it, in a session and on Agent Home: it comes back, it does
 * not show up in another composer, a file that had finished uploading is sent
 * without being uploaded a second time, and once sent it is gone.
 */
test.describe('Composer draft restore', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let agentName: string
  let tmpDir: string
  let uploads: number

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Lands on Agent Home, with one session (the creating prompt) behind it.
    agentName = `Draft Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(agentName)

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-draft-'))
    uploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/upload-file')) uploads += 1
    })
  })

  test.afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function openSession(page: Page) {
    await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentName))
    await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 15000 })
  }

  async function openAgentHome(page: Page) {
    await page.getByTestId('agent-breadcrumb').click()
    await expect(page.getByTestId('home-message-input')).toBeVisible({ timeout: 10000 })
  }

  test('a session draft comes back with its file and its model pick, and is sent as drafted', async ({ page }, testInfo) => {
    const text = `draft that must come back ${testInfo.workerIndex}-${Date.now()}`
    const filePath = path.join(tmpDir, 'notes.txt')
    fs.writeFileSync(filePath, 'a file drafted with the message')

    await openSession(page)
    await sessionPage.waitForResponse(15000)
    await sessionPage.waitForInputEnabled()

    await sessionPage.typeMessage(text)
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(filePath)
    const chip = attachmentPreview(page, 'notes.txt')
    await expect(chip).toHaveAttribute('data-attachment-status', 'done', { timeout: 10000 })
    await pickModel(page, HAIKU)
    await expect(page.getByTestId('composer-options-trigger')).toContainText('Haiku')
    const uploadsBeforeLeaving = uploads
    expect(uploadsBeforeLeaving).toBeGreaterThan(0)

    // Another composer, for the same agent: none of the session's draft is in it.
    await openAgentHome(page)
    await expect(page.getByTestId('home-message-input')).toHaveText('')
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
    await expect(page.getByTestId('composer-options-trigger')).not.toContainText('Haiku')

    // Back in the session: the text, the file as it finished, and the pick.
    await openSession(page)
    await expect(sessionPage.getMessageInput()).toHaveText(text)
    await expect(chip).toHaveAttribute('data-attachment-status', 'done')
    await expect(page.getByTestId('composer-options-trigger')).toContainText('Haiku')

    await sessionPage.getSendButton().click()
    const sent = await recorder.waitFor((r) => r.type === 'sendMessage' && !!r.content?.includes(text))
    expect(sent.model).toBe(HAIKU)
    expect(sent.content).toMatch(timestampedUploadNamePattern('notes.txt'))
    // The file was already in the agent's workspace: it went as it was.
    expect(uploads).toBe(uploadsBeforeLeaving)

    // Sent, so there is no draft left to come back.
    await expect(sessionPage.getMessageInput()).toHaveText('')
    await openAgentHome(page)
    await openSession(page)
    await expect(sessionPage.getMessageInput()).toHaveText('')
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
  })

  test('an Agent Home draft comes back with its file and its model pick, and starts the session with them', async ({ page }, testInfo) => {
    const text = `home draft that must come back ${testInfo.workerIndex}-${Date.now()}`
    const filePath = path.join(tmpDir, 'brief.txt')
    fs.writeFileSync(filePath, 'a file drafted on Agent Home')

    await page.getByTestId('home-message-input').fill(text)
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(filePath)
    const chip = attachmentPreview(page, 'brief.txt')
    await expect(chip).toHaveAttribute('data-attachment-status', 'done', { timeout: 10000 })
    await pickModel(page, HAIKU)
    await expect(page.getByTestId('composer-options-trigger')).toContainText('Haiku')
    const uploadsBeforeLeaving = uploads

    // The session's composer is its own: nothing drafted at home shows in it.
    await openSession(page)
    await sessionPage.waitForInputEnabled()
    await expect(sessionPage.getMessageInput()).toHaveText('')
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)

    await openAgentHome(page)
    await expect(page.getByTestId('home-message-input')).toHaveText(text)
    await expect(chip).toHaveAttribute('data-attachment-status', 'done')
    await expect(page.getByTestId('composer-options-trigger')).toContainText('Haiku')

    await page.getByTestId('home-send-button').click()
    const created = await recorder.waitFor((r) => r.type === 'createSession' && !!r.initialMessage?.includes(text))
    expect(created.model).toBe(HAIKU)
    expect(created.initialMessage).toMatch(timestampedUploadNamePattern('brief.txt'))
    expect(uploads).toBe(uploadsBeforeLeaving)

    // The new session has the pick; Agent Home is back to the agent's defaults with nothing drafted.
    await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 15000 })
    await openAgentHome(page)
    await expect(page.getByTestId('home-message-input')).toHaveText('')
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
    await expect(page.getByTestId('composer-options-trigger')).not.toContainText('Haiku')
  })
})
