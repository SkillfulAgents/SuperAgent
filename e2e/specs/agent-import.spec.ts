import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { buildAgentTemplateZip } from '../helpers/agent-template-zip'

const ONBOARDING_MESSAGE =
  'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

/**
 * Covers the AgentHome → import → onboarding-session flow refactored to use
 * `useStartOnboardingSession`. The wizard's CreateAgentForm uses the same
 * hook + AgentCreationAids component, so this test exercises both call sites'
 * shared behavior.
 */
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

  test('importing a template with the onboarding skill creates an onboarding session', async ({ page }) => {
    const agentName = `Imported Onboarding ${Date.now()}`
    const zipPath = buildAgentTemplateZip(
      path.join(tmpDir, 'with-onboarding.zip'),
      { name: agentName, withOnboardingSkill: true },
    )

    // Land on a fresh Untitled agent's AgentHome — this is where the import card lives.
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })

    // Open the Import dialog via the AgentCreationAids card.
    await page.getByRole('button', { name: 'Import an Agent — Import' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Upload the fixture zip into the dialog's hidden file input, then submit.
    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await expect(dialog.getByText('with-onboarding.zip')).toBeVisible()
    await dialog.locator('button[type="submit"]').click()

    // Dialog closes, then `useStartOnboardingSession` creates the onboarding
    // session and `selectSession` routes to it — the message list renders.
    await expect(dialog).not.toBeVisible({ timeout: 15000 })
    await expect(sessionPage.getMessageList()).toBeVisible({ timeout: 15000 })

    // The first user message in the new session is the onboarding prompt.
    await sessionPage.expectUserMessage(ONBOARDING_MESSAGE)

    // The imported agent is now selected in the sidebar.
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()
  })

  test('onboarding setup dialog is visible while the session is being created', async ({ page }) => {
    const agentName = `Imported Onboarding Dialog ${Date.now()}`
    const zipPath = buildAgentTemplateZip(
      path.join(tmpDir, 'onboarding-dialog.zip'),
      { name: agentName, withOnboardingSkill: true },
    )

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })

    await page.getByRole('button', { name: 'Import an Agent — Import' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await dialog.locator('button[type="submit"]').click()

    // MockContainerClient delays onboarding session creation by 2 s —
    // the "Setting up your agent…" dialog should be visible during this window.
    const setupDialog = page.locator('[data-testid="onboarding-setup-dialog"]')
    await expect(setupDialog).toBeVisible({ timeout: 10000 })
    await expect(setupDialog).toContainText('Setting up your agent')

    // After the delay resolves, the dialog disappears and the session appears.
    await expect(setupDialog).not.toBeVisible({ timeout: 15000 })
    await expect(sessionPage.getMessageList()).toBeVisible({ timeout: 15000 })
    await sessionPage.expectUserMessage(ONBOARDING_MESSAGE)
  })

  test('importing a template without the onboarding skill skips session creation', async ({ page }) => {
    const agentName = `Imported Plain ${Date.now()}`
    const zipPath = buildAgentTemplateZip(
      path.join(tmpDir, 'plain.zip'),
      { name: agentName, withOnboardingSkill: false },
    )

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })

    await page.getByRole('button', { name: 'Import an Agent — Import' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await dialog.locator('input[type="file"]').setInputFiles(zipPath)
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible({ timeout: 15000 })

    // No onboarding skill → the imported agent's AgentHome stays put. The
    // breadcrumb updates to the imported agent's name and the home composer
    // (not a session message list) is what's visible.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agentName, { timeout: 15000 })
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(sessionPage.getMessageList()).not.toBeVisible()
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()
  })
})
