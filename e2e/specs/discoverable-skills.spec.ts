import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.describe('Discoverable Skills - Browse & Install', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('Add Skill button opens browse dialog with the seeded skills', async ({ page }) => {
    await agentPage.createAgent(`Skills Browse ${Date.now()}`)

    const addSkillButton = page.locator('[data-testid="add-skill-button"]')
    await expect(addSkillButton).toBeVisible({ timeout: 10000 })
    await addSkillButton.click()

    const dialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(dialog).toBeVisible()

    // Both seeded skills are listed.
    await expect(dialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeVisible()
    await expect(dialog.locator('[data-skill-name="e2e-env-skill"]')).toBeVisible()

    // Search filters down to one card after the debounce settles.
    await dialog.getByPlaceholder('Search skills...').fill('plain')
    await expect(dialog.locator('[data-skill-name="e2e-env-skill"]')).toBeHidden()
    await expect(dialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeVisible()
  })

  test('installs a skill that requires no env vars', async ({ page }) => {
    await agentPage.createAgent(`Skills Plain ${Date.now()}`)

    await page.locator('[data-testid="add-skill-button"]').click()
    const dialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(dialog).toBeVisible()

    // Install button on the card has aria-label "Install <name>".
    await dialog.getByRole('button', { name: 'Install e2e-plain-skill' }).click()

    // After install, the env-vars dialog should NOT appear (skill has none),
    // the discoverable list re-renders without the installed skill, and the
    // installed list shows it.
    await expect(page.locator('[data-testid="skill-install-dialog"]')).toBeHidden()
    await expect(dialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeHidden({ timeout: 10000 })

    // Close the browse dialog (Escape) to inspect the agent home list.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    const installedRow = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-plain-skill"]')
    await expect(installedRow).toBeVisible({ timeout: 10000 })
  })

  test('installs a skill that requires env vars via the secrets dialog', async ({ page }) => {
    await agentPage.createAgent(`Skills Env ${Date.now()}`)

    await page.locator('[data-testid="add-skill-button"]').click()
    const browseDialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(browseDialog).toBeVisible()

    await browseDialog.getByRole('button', { name: 'Install e2e-env-skill' }).click()

    // The env-vars dialog opens with a field for E2E_TEST_API_KEY.
    const installDialog = page.locator('[data-testid="skill-install-dialog"]')
    await expect(installDialog).toBeVisible()
    await expect(installDialog.getByText('Install e2e-env-skill')).toBeVisible()

    const apiKeyInput = installDialog.locator('#env-E2E_TEST_API_KEY')
    await expect(apiKeyInput).toBeVisible()

    // Submit is disabled until the field has a value.
    const submitButton = installDialog.getByRole('button', { name: 'Install', exact: true })
    await expect(submitButton).toBeDisabled()

    await apiKeyInput.fill('fake-secret-value')
    await expect(submitButton).toBeEnabled()
    await submitButton.click()

    // Env-vars dialog closes; the env skill disappears from the browse list.
    await expect(installDialog).toBeHidden({ timeout: 10000 })
    await expect(browseDialog.locator('[data-skill-name="e2e-env-skill"]')).toBeHidden({ timeout: 10000 })

    await page.keyboard.press('Escape')
    await expect(browseDialog).toBeHidden()

    const installedRow = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-env-skill"]')
    await expect(installedRow).toBeVisible({ timeout: 10000 })
  })
})
