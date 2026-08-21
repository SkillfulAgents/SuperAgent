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

function filePill(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('file-pill').filter({ hasText: fileName })
}

test.describe('File & Folder Upload', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string
  let tmpDir: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `Upload Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)

    // Send an initial message to navigate to the session page (message-input.tsx)
    // This avoids the landing page's Cmd+Enter requirement
    await sessionPage.sendMessage('hello')
    await sessionPage.waitForResponse(15000)
    await sessionPage.waitForInputEnabled()

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-upload-'))
  })

  test.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('upload a single file and send message', async ({ page }) => {
    const filePath = path.join(tmpDir, 'test-doc.txt')
    fs.writeFileSync(filePath, 'Hello from test file')

    // Attach file via the hidden file input
    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])')
    await fileInput.setInputFiles(filePath)

    // Verify attachment preview appears
    await expect(attachmentPreview(page, 'test-doc.txt')).toBeVisible()

    // Send message with the attachment
    await sessionPage.sendMessage('Here is a file')
    await sessionPage.waitForUserMessageCount(2, 15000)

    // Verify the file pill renders in the sent message
    const pill = filePill(page, 'test-doc.txt').first()
    await expect(pill).toBeVisible({ timeout: 5000 })
  })

  test('send message with only attachment and no text', async ({ page }) => {
    const filePath = path.join(tmpDir, 'data.csv')
    fs.writeFileSync(filePath, 'col1,col2\n1,2')

    // Attach file
    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])')
    await fileInput.setInputFiles(filePath)

    await expect(attachmentPreview(page, 'data.csv')).toBeVisible()

    // Click send without typing text — on session page, Enter submits
    await page.locator('[data-testid="send-button"]').click()

    await sessionPage.waitForUserMessageCount(2, 15000)

    // File pill should render
    await expect(filePill(page, 'data.csv').first()).toBeVisible({ timeout: 5000 })
  })

  test('attachment can be removed before sending', async ({ page }) => {
    const filePath = path.join(tmpDir, 'removable.txt')
    fs.writeFileSync(filePath, 'will be removed')

    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])')
    await fileInput.setInputFiles(filePath)

    // Verify preview appears
    const removablePreview = attachmentPreview(page, 'removable.txt')
    await expect(removablePreview).toBeVisible()

    // Click the X button next to the attachment
    await removablePreview.getByTestId('attachment-remove').click()

    // Verify attachment is gone
    await expect(removablePreview).not.toBeVisible()
  })

  test('multiple files can be attached and sent', async ({ page }) => {
    const file1 = path.join(tmpDir, 'first.txt')
    const file2 = path.join(tmpDir, 'second.md')
    fs.writeFileSync(file1, 'first')
    fs.writeFileSync(file2, 'second')

    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])')
    await fileInput.setInputFiles([file1, file2])

    // Verify both previews appear
    await expect(attachmentPreview(page, 'first.txt')).toBeVisible()
    await expect(attachmentPreview(page, 'second.md')).toBeVisible()

    await sessionPage.sendMessage('Two files attached')
    await sessionPage.waitForUserMessageCount(2, 15000)

    // Both file pills should render
    const pills = page.getByTestId('file-pill')
    await expect(pills).toHaveCount(2, { timeout: 5000 })
  })

  test('file pill opens the preview pane when clicked', async ({ page }) => {
    const filePath = path.join(tmpDir, 'report.pdf')
    fs.writeFileSync(filePath, 'fake pdf content')

    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])')
    await fileInput.setInputFiles(filePath)

    await sessionPage.sendMessage('Check this report')
    await sessionPage.waitForUserMessageCount(2, 15000)

    // Regular file pill is a clickable button (folders render a non-interactive span).
    const pill = filePill(page, 'report.pdf').first()
    await expect(pill).toBeVisible({ timeout: 5000 })
    await expect(pill).toHaveAttribute('role', 'button')

    // Clicking it opens the file preview pane with the file in a tab.
    await pill.click()
    const tabBar = page.getByTestId('file-tab-bar')
    await expect(tabBar).toBeVisible({ timeout: 5000 })
    await expect(tabBar).toContainText('report.pdf')
  })
})
