import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import {
  armTranscriptNotFoundWatch,
  expectOnboardingSessionToOpenCleanly,
} from '../helpers/onboarding-session'

/**
 * Discover → install a marketplace template that ships the agent-onboarding
 * skill → the onboarding session opens and runs. The seeded public skillset
 * (e2e/setup-e2e-data.js) carries one such template.
 */
test.describe('Template install with onboarding skill', () => {
  test('installing the template opens a working onboarding session, never a missing one', async ({ page }) => {
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await page.goto('/explore/github-com-skillfulagents-public-skillset/e2e-onboarding-template')
    await expect(page.getByTestId('template-detail-view')).toBeVisible()
    await armTranscriptNotFoundWatch(page)
    await page.getByTestId('template-detail-install').click()

    // Install progress, then the "Setting up your agent…" card while the
    // session is created (the mock holds createSession for 2 s).
    const install = page.getByTestId('template-install-status')
    const setup = page.getByTestId('onboarding-setup-dialog')
    await expect(install.or(setup).first()).toBeVisible({ timeout: 15_000 })
    await expect(setup).toBeVisible({ timeout: 15_000 })
    await expect(setup).toBeHidden({ timeout: 15_000 })

    await expectOnboardingSessionToOpenCleanly(page)

    const sidebar = page.locator('[data-testid="app-sidebar"]')
    await expect(sidebar.getByText('E2E Onboarding Template', { exact: true }).first()).toBeVisible()
  })
})
