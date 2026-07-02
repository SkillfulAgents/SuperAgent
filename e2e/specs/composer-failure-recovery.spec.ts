import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

function attachmentPreview(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('attachment-preview').filter({ hasText: fileName })
}

/**
 * Composer failure recovery: a failed send or a failed attachment upload must
 * never lose the user's work.
 *
 * Two data-loss guards in use-message-composer are pinned here:
 * - a failed message POST restores the typed text into the composer (the
 *   optimistic ghost is dropped, nothing lands in the transcript), and the
 *   restored text can be resent as-is once the server recovers;
 * - a failed attachment upload short-circuits BEFORE the composer is cleared,
 *   surfacing a dismissible error while both the text and the attachment
 *   chips stay intact for a retry.
 *
 * Failures are injected per-page with route interception (POST-only — the
 * transcript GETs on the same URL shape must keep flowing), so the tests are
 * fully parallel-safe.
 */
test.describe('Composer failure recovery', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let tmpDir: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    const testAgentName = `Recovery Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)

    // Land on the session page (message-input.tsx) with one completed turn,
    // so the tests exercise sends into an existing idle session
    await sessionPage.sendMessage('hello')
    await sessionPage.waitForResponse(15000)
    await sessionPage.waitForInputEnabled()

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-recovery-'))
  })

  test.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a failed send restores the typed text for a successful resend', async ({ page }) => {
    const text = 'this message must survive the failed send'

    // Fail message POSTs; transcript GETs on the same URL shape pass through
    await page.route('**/sessions/*/messages', (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Injected send failure' }),
      })
    })

    await sessionPage.typeMessage(text)
    await sessionPage.getSendButton().click()

    // The typed text is restored into the composer, the optimistic ghost is
    // dropped, and nothing landed in the transcript
    await expect(sessionPage.getMessageInput()).toHaveValue(text, { timeout: 10000 })
    await expect(sessionPage.getUserMessages()).toHaveCount(1)

    // Server recovers — the restored text resends as-is
    await page.unroute('**/sessions/*/messages')
    await sessionPage.getSendButton().click()

    await sessionPage.waitForUserMessageCount(2, 15000)
    await sessionPage.expectUserMessage(text, 1)
    await expect(
      sessionPage.getAssistantMessages().filter({ hasText: 'This is a mock response from the E2E test container.' })
    ).toHaveCount(2, { timeout: 15000 })
    await expect(sessionPage.getMessageInput()).toHaveValue('')
  })

  test('a failed upload preserves text and attachment for a retry', async ({ page }) => {
    const filePath = path.join(tmpDir, 'guarded.txt')
    fs.writeFileSync(filePath, 'file content that must not be lost')
    const text = 'upload failure must keep my work'

    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])')
    await fileInput.setInputFiles(filePath)
    await expect(attachmentPreview(page, 'guarded.txt')).toBeVisible()
    await sessionPage.typeMessage(text)

    await page.route('**/upload-file*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Injected upload failure' }),
    }))

    await sessionPage.getSendButton().click()

    // The inline upload error surfaces in the composer (the same message also
    // fires as a toast, so scope to the content area), and BOTH the text and
    // the attachment chip survive — the send never happened
    const inlineError = page.getByTestId('main-content').getByText('Injected upload failure')
    await expect(inlineError).toBeVisible({ timeout: 10000 })
    await expect(sessionPage.getMessageInput()).toHaveValue(text)
    await expect(attachmentPreview(page, 'guarded.txt')).toBeVisible()
    await expect(sessionPage.getUserMessages()).toHaveCount(1)

    // The inline error is dismissible
    await page.getByTestId('main-content').getByRole('button', { name: 'Dismiss' }).click()
    await expect(inlineError).not.toBeVisible()

    // Server recovers — the same composed message (text + file) sends through
    await page.unroute('**/upload-file*')
    await sessionPage.getSendButton().click()

    await sessionPage.waitForUserMessageCount(2, 15000)
    await sessionPage.expectUserMessage(text, 1)
    await expect(page.getByTestId('file-pill').filter({ hasText: 'guarded.txt' }).first()).toBeVisible({ timeout: 5000 })
    await expect(sessionPage.getMessageInput()).toHaveValue('')
  })
})
