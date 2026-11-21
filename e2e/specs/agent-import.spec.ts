import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { buildAgentTemplateZip } from '../helpers/agent-template-zip'
import {
  ONBOARDING_MESSAGE,
  armTranscriptNotFoundWatch,
  expectOnboardingSessionToOpenCleanly,
} from '../helpers/onboarding-session'

/**
 * Covers importing on the create page's job step, and the onboarding session
 * `useStartOnboardingSession` starts for a package that carries the skill.
 * The teammate is named first, so the import takes that name (not the
 * package's) and replaces the empty agent the name step made.
 */
const PACKAGE_NAME = 'Name inside the package'
test.describe('Agent Import Onboarding', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let tmpDir: string

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-import-'))
  })

  test.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  /** Name a new teammate, then import one in place of describing its job. */
  async function openImportDialog(page: Page, agentName: string) {
    await agentPage.clickCreateAgent()
    await agentPage.nameNewAgent(agentName)
    await page.getByRole('button', { name: 'Import an agent' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    return dialog
  }

  test('importing a template with the onboarding skill creates an onboarding session', async ({ page }) => {
    const agentName = `Imported Onboarding ${Date.now()}`
    const zipPath = await buildAgentTemplateZip(
      path.join(tmpDir, 'with-onboarding.zip'),
      { name: PACKAGE_NAME, withOnboardingSkill: true },
    )

    const dialog = await openImportDialog(page, agentName)

    // Upload the fixture zip into the dialog's hidden file input, then submit.
    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await expect(dialog.getByText('with-onboarding.zip')).toBeVisible()
    await armTranscriptNotFoundWatch(page)
    await dialog.locator('button[type="submit"]').click()

    // Dialog closes, then `useStartOnboardingSession` creates the onboarding
    // session and `selectSession` routes to it — the message list renders,
    // and the first user message in it is the onboarding prompt.
    await expect(dialog).not.toBeVisible({ timeout: 15000 })
    await expectOnboardingSessionToOpenCleanly(page)
    await sessionPage.expectUserMessage(ONBOARDING_MESSAGE)

    // The imported agent is now selected in the sidebar.
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()
  })

  test('onboarding setup dialog is visible while the session is being created', async ({ page }) => {
    const agentName = `Imported Onboarding Dialog ${Date.now()}`
    const zipPath = await buildAgentTemplateZip(
      path.join(tmpDir, 'onboarding-dialog.zip'),
      { name: PACKAGE_NAME, withOnboardingSkill: true },
    )

    const dialog = await openImportDialog(page, agentName)

    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await armTranscriptNotFoundWatch(page)
    await dialog.locator('button[type="submit"]').click()

    // MockContainerClient delays onboarding session creation by 2 s —
    // the "Setting up your agent…" dialog should be visible during this window.
    const setupDialog = page.locator('[data-testid="onboarding-setup-dialog"]')
    await expect(setupDialog).toBeVisible({ timeout: 10000 })
    await expect(setupDialog).toContainText('Setting up your agent')

    // After the delay resolves, the dialog disappears and the session appears.
    await expect(setupDialog).not.toBeVisible({ timeout: 15000 })
    await expectOnboardingSessionToOpenCleanly(page)
    await sessionPage.expectUserMessage(ONBOARDING_MESSAGE)
  })

  test('importing a template without the onboarding skill skips session creation', async ({ page }) => {
    const agentName = `Imported Plain ${Date.now()}`
    const zipPath = await buildAgentTemplateZip(
      path.join(tmpDir, 'plain.zip'),
      { name: PACKAGE_NAME, withOnboardingSkill: false },
    )

    const dialog = await openImportDialog(page, agentName)

    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible({ timeout: 15000 })

    // No onboarding skill → the create page hands off to the imported agent's
    // AgentHome: its breadcrumb and the home composer (not a session message
    // list) are what's visible.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName, { timeout: 15000 })
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(sessionPage.getMessageList()).not.toBeVisible()
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // One agent under the chosen name: the imported one. The empty agent the
    // name step made is gone, and the package's own name was never used.
    await expect.poll(async () => {
      const agents = await (await page.request.get('/api/agents')).json() as { name: string }[]
      return agents.filter((agent) => agent.name === agentName || agent.name === PACKAGE_NAME).map((agent) => agent.name)
    }).toEqual([agentName])
  })

  test('importing a branded .agent package file works like a .zip', async ({ page }) => {
    const agentName = `Imported Branded ${Date.now()}`
    // Same zip bytes exports now produce — only the extension differs.
    const packagePath = await buildAgentTemplateZip(
      path.join(tmpDir, 'branded.agent'),
      { name: PACKAGE_NAME, withOnboardingSkill: false },
    )

    const dialog = await openImportDialog(page, agentName)

    // The relaxed extension guard must accept the file (no "Only .agent or
    // .zip" toast) and show it as ready to import.
    await dialog.locator('input[type="file"]').setInputFiles(packagePath)
    await expect(dialog.getByText('branded.agent')).toBeVisible()
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible({ timeout: 15000 })

    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName, { timeout: 15000 })
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()
  })
})
