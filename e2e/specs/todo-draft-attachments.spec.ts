import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

test.describe('Todo draft attachments', () => {
  let tmpDir: string

  test.beforeEach(async ({ page }) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-todo-att-'))
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await page.goto('/settings/experiments')
    const toggle = page.getByTestId('experiment-switch-todo-board')
    if (!(await toggle.isChecked())) await toggle.click()
    await expect(toggle).toBeChecked()
  })

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('holds a file, reopens it, and sends it when the draft starts', async ({ page }) => {
    test.setTimeout(90_000)
    const agentName = `Todo Attach ${Date.now()}`
    const agentPage = new AgentPage(page)
    await page.goto('/')
    await agentPage.createAgent(agentName, { waitForSidebarName: false })

    await page.goto('/todo')
    await expect(page.getByTestId('todo-board')).toBeVisible()
    await page.getByTestId('todo-new-draft').click()
    const dialog = page.getByTestId('todo-draft-dialog')
    await expect(dialog).toBeVisible()

    const filePath = path.join(tmpDir, 'Q3 report.txt')
    fs.writeFileSync(filePath, 'quarterly numbers')
    await dialog.getByTestId('todo-draft-title').fill('Q3 report')
    await page.getByTestId('todo-assign-agent').click()
    await page.getByRole('option', { name: agentName }).click()
    await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(filePath)
    const chip = dialog.getByTestId('attachment-preview').filter({ hasText: 'Q3 report.txt' })
    await expect(chip).toBeVisible({ timeout: 15000 })

    await page.getByTestId('todo-draft-close').click()
    await expect(dialog).toBeHidden()

    await page.getByTestId('todo-card').filter({ hasText: 'Q3 report' }).click()
    await expect(page.getByTestId('todo-draft-dialog').getByTestId('attachment-preview').filter({ hasText: 'Q3 report.txt' })).toBeVisible()
    await expect(page.getByTestId('todo-assign-agent')).toBeEnabled()
    await page.getByTestId('todo-draft-start').click()
    await expect(page.getByTestId('todo-draft-dialog')).toBeHidden({ timeout: 20000 })

    await page.getByTestId('todo-card').filter({ hasText: 'Q3 report' }).click()
    await expect(page.getByTestId('file-pill').filter({ hasText: /Q3_report-\d+\.txt/ }).first()).toBeVisible({ timeout: 20000 })
  })

  test('asks for an agent before a file can be attached', async ({ page }) => {
    await page.goto('/todo')
    await page.getByTestId('todo-new-draft').click()
    const dialog = page.getByTestId('todo-draft-dialog')

    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['x'], 'note.txt', { type: 'text/plain' }))
      return transfer
    })
    const title = dialog.getByTestId('todo-draft-title')
    await title.dispatchEvent('dragover', { dataTransfer })
    await title.dispatchEvent('drop', { dataTransfer })
    await expect(page.getByText('Pick an agent to attach files')).toBeVisible()
    await expect(page).toHaveURL(/\/todo$/)
    await expect(dialog.getByTestId('attachment-preview')).toHaveCount(0)

    await expect(dialog.getByRole('button', { name: 'Add files' })).toBeDisabled()
    await dialog.getByTestId('todo-attach-needs-agent').hover()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Pick an agent to attach files' })).toBeVisible()
  })

  test('offers a folder attach', async ({ page }) => {
    const agentName = `Todo Folder ${Date.now()}`
    const agentPage = new AgentPage(page)
    await page.goto('/')
    await agentPage.createAgent(agentName, { waitForSidebarName: false })
    await page.goto('/todo')
    await page.getByTestId('todo-new-draft').click()
    await page.getByTestId('todo-assign-agent').click()
    await page.getByRole('option', { name: agentName }).click()
    await page.getByRole('button', { name: 'Add files' }).click()
    await expect(page.getByRole('button', { name: 'Folder', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible()
  })
})
