import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { buildSkillZip } from '../helpers/skill-zip'

test.describe('Skill Export & Import', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let tmpDir: string

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-skill-'))
  })

  test.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('import a skill via the Import dialog', async ({ page }) => {
    const skillName = `e2e-imported-${Date.now()}`
    const zipPath = await buildSkillZip(
      path.join(tmpDir, 'skill.zip'),
      { name: skillName },
    )

    await agentPage.createAgent(`Skill Imp ${Date.now()}`)

    const importButton = page.locator('[data-testid="import-skill-button"]')
    await expect(importButton).toBeVisible({ timeout: 10000 })
    await importButton.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await expect(dialog.getByText('skill.zip')).toBeVisible()

    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible({ timeout: 15000 })

    const installedRow = page.locator('[data-testid="installed-skill-row"]').filter({ hasText: skillName })
    await expect(installedRow).toBeVisible({ timeout: 10000 })
  })

  test('import shows error for ZIP without SKILL.md', async ({ page }) => {
    const badZipPath = await buildSkillZip(
      path.join(tmpDir, 'bad.zip'),
      { name: 'will-be-replaced' },
    )
    // Overwrite with a zip that has no SKILL.md by building one manually
    // using the same writeZipFile the helper uses
    const { writeZipFile } = await import('../../src/shared/lib/utils/zip')
    await writeZipFile(badZipPath, { 'README.md': '# Not a skill' })

    await agentPage.createAgent(`Bad Imp ${Date.now()}`)

    const importButton = page.locator('[data-testid="import-skill-button"]')
    await expect(importButton).toBeVisible({ timeout: 10000 })
    await importButton.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await dialog.locator('input[type="file"]').setInputFiles(badZipPath)
    await dialog.locator('button[type="submit"]').click()

    await expect(dialog.locator('.text-destructive')).toBeVisible({ timeout: 10000 })
  })

  test('export a skill via three-dot menu', async ({ page }) => {
    await agentPage.createAgent(`Skill Exp ${Date.now()}`)

    const addSkillButton = page.locator('[data-testid="add-skill-button"]')
    await expect(addSkillButton).toBeVisible({ timeout: 10000 })
    await addSkillButton.click()

    const browseDialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(browseDialog).toBeVisible()
    await browseDialog.getByRole('button', { name: 'Install e2e-plain-skill' }).click()
    await expect(browseDialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeHidden({ timeout: 10000 })
    await page.keyboard.press('Escape')

    const installedRow = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-plain-skill"]')
    await expect(installedRow).toBeVisible({ timeout: 10000 })

    await installedRow.hover()
    const moreButton = installedRow.locator('button[aria-label*="Actions"]')
    await expect(moreButton).toBeVisible()
    await moreButton.click()

    // Use getByText with exact match to avoid matching the agent name in sidebar
    const exportButton = page.getByText('Export Skill', { exact: true })
    await expect(exportButton).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await exportButton.click()

    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('e2e-plain-skill')
    expect(download.suggestedFilename()).toMatch(/\.zip$/)
  })

  test('round-trip: export from one agent, import into another', async ({ page }) => {
    await agentPage.createAgent(`RT Exp ${Date.now()}`)

    const addSkillButton = page.locator('[data-testid="add-skill-button"]')
    await expect(addSkillButton).toBeVisible({ timeout: 10000 })
    await addSkillButton.click()

    const browseDialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(browseDialog).toBeVisible()
    await browseDialog.getByRole('button', { name: 'Install e2e-plain-skill' }).click()
    await expect(browseDialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeHidden({ timeout: 10000 })
    await page.keyboard.press('Escape')

    const installedRow = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-plain-skill"]')
    await expect(installedRow).toBeVisible({ timeout: 10000 })
    await installedRow.hover()
    await installedRow.locator('button[aria-label*="Actions"]').click()

    const downloadPromise = page.waitForEvent('download')
    await page.getByText('Export Skill', { exact: true }).click()
    const download = await downloadPromise

    const downloadPath = path.join(tmpDir, 'exported-skill.zip')
    await download.saveAs(downloadPath)

    // Agent 2: import the exported skill
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })

    await page.locator('[data-testid="home-message-input"]').fill('round trip test')
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(page.locator('[data-testid="agent-settings-button"]')).toBeVisible()

    const importButton = page.locator('[data-testid="import-skill-button"]')
    await expect(importButton).toBeVisible({ timeout: 10000 })
    await importButton.click()

    const importDialog = page.getByRole('dialog')
    await expect(importDialog).toBeVisible()
    await importDialog.locator('input[type="file"]').setInputFiles(downloadPath)
    await importDialog.locator('button[type="submit"]').click()
    await expect(importDialog).not.toBeVisible({ timeout: 15000 })

    const importedRow = page.locator('[data-testid="installed-skill-row"]').filter({ hasText: 'e2e-plain-skill' })
    await expect(importedRow).toBeVisible({ timeout: 10000 })
  })
})
