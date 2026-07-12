import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.describe('Public Skillset Provider', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('public skillset appears in Settings > Skillsets with Public badge', async ({ page }) => {
    // Settings now lives inside the footer account menu
    await page.locator('[data-testid="user-menu-trigger"]').click()
    await page.locator('[data-testid="settings-button"]').click()
    // Settings nav items are now links (URL-driven tabs), so target the stable
    // testid rather than a button role.
    await page.locator('[data-testid="settings-nav-skillsets"]').click()

    const publicRow = page.locator('div.flex.items-start.gap-3').filter({ hasText: 'E2E Public Skillset' })
    await expect(publicRow).toBeVisible({ timeout: 10000 })
    await expect(publicRow.getByText('1 skill')).toBeVisible()
    await expect(publicRow.getByText('Public', { exact: true })).toBeVisible()
  })

  test('skills from public skillset appear in agent discoverable skills', async ({ page }) => {
    await agentPage.createAgent(`Public Skills Browse ${Date.now()}`)

    const addSkillButton = page.locator('[data-testid="add-skill-button"]')
    await expect(addSkillButton).toBeVisible({ timeout: 10000 })
    await addSkillButton.click()

    const skillDialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(skillDialog).toBeVisible()

    await expect(skillDialog.locator('[data-skill-name="e2e-public-skill"]')).toBeVisible()
  })

  test('installing a skill from public skillset works', async ({ page }) => {
    await agentPage.createAgent(`Public Skills Install ${Date.now()}`)

    await page.locator('[data-testid="add-skill-button"]').click()
    const dialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Install e2e-public-skill' }).click()
    await expect(dialog.locator('[data-skill-name="e2e-public-skill"]')).toBeHidden({ timeout: 10000 })

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    const installedSkill = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-public-skill"]')
    await expect(installedSkill).toBeVisible({ timeout: 10000 })
  })

  test('publish buttons do not appear for skills from public skillset', async ({ page }) => {
    await agentPage.createAgent(`Public Skills NoPublish ${Date.now()}`)

    await page.locator('[data-testid="add-skill-button"]').click()
    const dialog = page.locator('[data-testid="skills-browse-dialog"]')
    await expect(dialog).toBeVisible()

    await dialog.getByRole('button', { name: 'Install e2e-public-skill' }).click()
    await expect(dialog.locator('[data-skill-name="e2e-public-skill"]')).toBeHidden({ timeout: 10000 })

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    const installedSkill = page.locator('[data-testid="installed-skill-row"][data-skill-path="e2e-public-skill"]')
    await expect(installedSkill).toBeVisible({ timeout: 10000 })

    // Hover to reveal the actions popover
    await installedSkill.hover()
    const actionsButton = installedSkill.locator('button[aria-label]')
    if (await actionsButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await actionsButton.click()
      const popoverContent = page.locator('[data-radix-popper-content-wrapper]')
      await expect(popoverContent.getByText('Publish Skill')).not.toBeVisible()
      await expect(popoverContent.getByText('Open PR')).not.toBeVisible()
      await expect(popoverContent.getByText('Push')).not.toBeVisible()
    }
  })
})
