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

    // The seeded skill is listed.
    await expect(dialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeVisible()

    // Search filters cards by name after the debounce settles.
    await dialog.getByPlaceholder('Search skills...').fill('plain')
    await expect(dialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeVisible()
  })

  test('installs a discoverable skill directly into the agent', async ({ page }) => {
    await agentPage.createAgent(`Skills Plain ${Date.now()}`)

    await page.locator('[data-testid="add-skill-button"]').click()
    const dialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(dialog).toBeVisible()

    // Install button on the card has aria-label "Install <name>".
    await dialog.getByRole('button', { name: 'Install e2e-plain-skill' }).click()

    // Discoverable list re-renders without the installed skill, and the
    // installed list shows it.
    await expect(dialog.locator('[data-skill-name="e2e-plain-skill"]')).toBeHidden({ timeout: 10000 })

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    const installedRow = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-plain-skill"]')
    await expect(installedRow).toBeVisible({ timeout: 10000 })
  })
})
