import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
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

  async function openSavedDraft(page: Page, request: APIRequestContext) {
    const title = `Attachment recovery ${Date.now()}`
    const agentResponse = await request.post('/api/agents', { data: { name: title } })
    expect(agentResponse.ok()).toBeTruthy()
    const agent = await agentResponse.json()
    const response = await request.post('/api/todos', { data: { title, description: '', agentSlug: agent.slug } })
    expect(response.ok()).toBeTruthy()
    const todo = await response.json()
    await page.goto('/todo')
    await page.getByTestId('todo-card').filter({ hasText: title }).click()
    await expect(page.getByTestId('todo-draft-dialog')).toBeVisible()
    return { id: todo.id as string, title }
  }

  for (const action of ['close', 'save', 'archive'] as const) {
    test(`keeps chat's error chip when an upload fails during ${action}`, async ({ page, request }) => {
      const todo = await openSavedDraft(page, request)
      const dialog = page.getByTestId('todo-draft-dialog')
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      let uploads = 0
      await page.route('**/upload-file', async (route) => {
        uploads += 1
        if (uploads > 1) return route.continue()
        await held
        await route.fulfill({ status: 503, json: { error: 'Temporary upload failure' } })
      })
      await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
        name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('quarterly numbers'),
      })
      const chip = dialog.getByTestId('attachment-preview').filter({ hasText: 'report.txt' })
      await expect(chip).toBeVisible()
      await dialog.getByTestId(`todo-draft-${action}`).click()
      await expect(dialog.getByTestId('todo-draft-save')).toHaveText('Finishing uploads…')
      release()
      await expect(chip).toHaveAttribute('data-attachment-status', 'error')
      await expect(chip.getByText('upload failed')).toBeVisible()
      await expect(chip.getByTestId('attachment-retry')).toBeVisible()
      await expect(dialog.getByTestId('todo-draft-save')).toBeEnabled()
      expect(uploads).toBe(1)

      if (action === 'archive') {
        await chip.getByRole('button', { name: 'Remove report.txt' }).click()
      } else {
        await chip.getByTestId('attachment-retry').click()
        await expect(chip).toHaveAttribute('data-attachment-status', 'done')
      }
      await dialog.getByTestId(`todo-draft-${action}`).click()
      await expect(dialog).toBeHidden()
      const { todos } = await (await request.get('/api/todos')).json()
      const stored = todos.find((item: { id: string }) => item.id === todo.id)
      expect(stored.status).toBe(action === 'archive' ? 'archived' : 'draft')
      expect(stored.attachments).toHaveLength(action === 'archive' ? 0 : 1)
    })
  }

  test('a rejected upload shows the shared error treatment without offering another identical request', async ({ page, request }) => {
    await openSavedDraft(page, request)
    const dialog = page.getByTestId('todo-draft-dialog')
    let uploads = 0
    await page.route('**/upload-file', async (route) => {
      uploads += 1
      await route.fulfill({ status: 413, json: { error: 'File is too large' } })
    })
    await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.from('large file'),
    })
    const chip = dialog.getByTestId('attachment-preview')
    await expect(chip).toHaveAttribute('data-attachment-status', 'error')
    await expect(chip.getByText('upload failed')).toBeVisible()
    await expect(chip.getByTestId('attachment-retry')).toHaveCount(0)
    await dialog.getByTestId('todo-draft-start').click()
    await expect(dialog.getByTestId('todo-draft-start')).toBeEnabled()
    expect(uploads).toBe(1)
    await chip.getByRole('button', { name: 'Remove large.txt' }).click()
    await dialog.getByTestId('todo-draft-close').click()
    await expect(dialog).toBeHidden()
  })

  for (const dismiss of ['close', 'escape'] as const) {
    test(`does not repeat an HTTP 409 save when dismissed with ${dismiss}`, async ({ page, request }) => {
      const todo = await openSavedDraft(page, request)
      const dialog = page.getByTestId('todo-draft-dialog')
      const archived = await request.post(`/api/todos/${todo.id}/status`, { data: { status: 'archived' } })
      expect(archived.ok()).toBeTruthy()
      let patches = 0
      await page.route(`**/api/todos/${todo.id}`, async (route) => {
        if (route.request().method() === 'PATCH') patches += 1
        await route.continue()
      })
      await dialog.getByTestId('todo-draft-title').fill('Unsaved edit after archive')
      await expect(dialog.getByTestId('todo-draft-save-error')).toBeVisible()
      await expect(dialog.getByTestId('todo-draft-save')).toBeDisabled()
      if (dismiss === 'escape') await page.keyboard.press('Escape')
      else await dialog.getByTestId('todo-draft-close').click()
      await expect(dialog).toBeHidden()
      expect(patches).toBe(1)
    })
  }

  test('keeps unsaved edits after HTTP 503 and saves them on an explicit retry', async ({ page, request }) => {
    const todo = await openSavedDraft(page, request)
    const dialog = page.getByTestId('todo-draft-dialog')
    let patches = 0
    await page.route(`**/api/todos/${todo.id}`, async (route) => {
      if (route.request().method() === 'PATCH' && ++patches === 1) {
        return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
      }
      await route.continue()
    })
    await dialog.getByTestId('todo-draft-title').fill('Keep my edited title')
    await dialog.getByTestId('todo-draft-close').click()
    await expect(dialog.getByTestId('todo-draft-save-error')).toHaveText('Temporarily unavailable')
    await expect(dialog.getByTestId('todo-draft-title')).toHaveValue('Keep my edited title')
    expect(patches).toBe(1)
    await dialog.getByRole('button', { name: 'Retry save' }).click()
    await expect(dialog).toBeHidden()
    expect(patches).toBe(2)
    await expect(page.getByTestId('todo-card').filter({ hasText: 'Keep my edited title' })).toBeVisible()
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
    await expect(page.getByTestId('todo-assign-agent')).toBeDisabled()
    await page.getByTestId('todo-draft-dialog').getByTestId('todo-agent-locked').hover()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Remove attached files to change the agent' })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.getByTestId('todo-draft-start').click()
    await expect(page.getByTestId('todo-draft-dialog')).toBeHidden({ timeout: 20000 })

    await page.getByTestId('todo-card').filter({ hasText: 'Q3 report' }).click()
    await expect(page.getByTestId('file-pill').filter({ hasText: /Q3_report-\d+\.txt/ }).first()).toBeVisible({ timeout: 20000 })
  })

  test('asks for the agent when a file is dropped, then attaches it', async ({ page }) => {
    const agentName = `Todo Drop ${Date.now()}`
    await page.goto('/')
    await new AgentPage(page).createAgent(agentName, { waitForSidebarName: false })
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
    const ask = page.getByTestId('todo-pick-agent-to-attach')
    await expect(ask).toBeVisible()
    await expect(page).toHaveURL(/\/todo$/)
    await page.getByRole('option', { name: agentName }).click()
    await expect(ask).toBeHidden()
    await expect(page.getByTestId('todo-assign-agent')).toContainText(agentName)
    await expect(dialog.getByTestId('attachment-preview').filter({ hasText: 'note.txt' })).toBeVisible({ timeout: 15000 })
    // A blank draft is saved under the file's name.
    await page.getByTestId('todo-draft-close').click()
    await expect(page.getByTestId('todo-card').filter({ hasText: 'note.txt' })).toBeVisible()
  })

  test('a file removed while it uploads is not kept on the draft', async ({ page }) => {
    const agentName = `Todo Remove ${Date.now()}`
    await page.goto('/')
    await new AgentPage(page).createAgent(agentName, { waitForSidebarName: false })
    await page.goto('/todo')
    await page.getByTestId('todo-new-draft').click()
    const dialog = page.getByTestId('todo-draft-dialog')
    await dialog.getByTestId('todo-draft-title').fill('Keep me')
    await page.getByTestId('todo-assign-agent').click()
    await page.getByRole('option', { name: agentName }).click()

    // The bytes are held in flight until the chip is removed.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let reached!: () => void
    const uploading = new Promise<void>((resolve) => { reached = resolve })
    await page.route('**/upload-file', async (route) => {
      reached()
      await held
      // The removal aborted the request, so there is nothing left to continue.
      await route.continue().catch(() => {})
    })
    const filePath = path.join(tmpDir, 'gone.txt')
    fs.writeFileSync(filePath, 'removed while it uploaded')
    await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(filePath)
    await uploading
    const chip = dialog.getByTestId('attachment-preview').filter({ hasText: 'gone.txt' })
    await chip.getByRole('button', { name: 'Remove gone.txt' }).click()
    await expect(chip).toBeHidden()
    release()
    await page.unroute('**/upload-file')

    await page.getByTestId('todo-draft-close').click()
    await expect(dialog).toBeHidden()
    await page.getByTestId('todo-card').filter({ hasText: 'Keep me' }).click()
    await expect(page.getByTestId('todo-draft-dialog')).toBeVisible()
    await expect(page.getByTestId('todo-draft-dialog').getByTestId('attachment-preview')).toHaveCount(0)
    await expect(page.getByTestId('todo-assign-agent')).toBeEnabled()
  })

  test('says it is finishing uploads when closed mid-upload', async ({ page }) => {
    const agentName = `Todo Close ${Date.now()}`
    await page.goto('/')
    await new AgentPage(page).createAgent(agentName, { waitForSidebarName: false })
    await page.goto('/todo')
    await page.getByTestId('todo-new-draft').click()
    const dialog = page.getByTestId('todo-draft-dialog')
    await dialog.getByTestId('todo-draft-title').fill('Big upload')
    await page.getByTestId('todo-assign-agent').click()
    await page.getByRole('option', { name: agentName }).click()

    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/upload-file', async (route) => {
      await held
      await route.continue()
    })
    const filePath = path.join(tmpDir, 'big.txt')
    fs.writeFileSync(filePath, 'large file')
    await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(filePath)
    await expect(dialog.getByTestId('attachment-preview').filter({ hasText: 'big.txt' })).toBeVisible()

    await page.getByTestId('todo-draft-close').click()
    await expect(dialog.getByTestId('todo-draft-save')).toHaveText('Finishing uploads…')
    await expect(dialog.getByTestId('todo-draft-save')).toBeDisabled()
    // While close waits, the chip cannot be removed out from under it.
    await dialog.getByRole('button', { name: 'Remove big.txt' }).click()
    await expect(dialog.getByTestId('attachment-preview').filter({ hasText: 'big.txt' })).toBeVisible()
    release()
    await expect(dialog).toBeHidden({ timeout: 15000 })
    await page.unroute('**/upload-file')
  })

  test('asks for the agent from the paperclip, then opens the attach menu', async ({ page }) => {
    const agentName = `Todo Clip ${Date.now()}`
    await page.goto('/')
    await new AgentPage(page).createAgent(agentName, { waitForSidebarName: false })
    await page.goto('/todo')
    await page.getByTestId('todo-new-draft').click()
    const dialog = page.getByTestId('todo-draft-dialog')

    await dialog.getByTestId('todo-attach-needs-agent').hover()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Pick an agent to attach files' })).toBeVisible()
    await dialog.getByTestId('todo-attach-needs-agent').click()
    const ask = page.getByTestId('todo-pick-agent-to-attach')
    await expect(ask).toBeVisible()
    await page.getByRole('option', { name: agentName }).click()
    await expect(ask).toBeHidden()
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible()
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
