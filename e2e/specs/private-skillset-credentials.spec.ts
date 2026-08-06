import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe('Private Git skillset credentials', () => {
  test.beforeEach(async ({ page }) => {
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await page.locator('[data-testid="settings-button"]').click()
    await page.locator('[data-testid="settings-nav-skillsets"]').click()
  })

  test('renders an optional masked token field and a redacted credential summary', async ({ page }) => {
    const tokenInput = page.getByLabel('Repository token (optional)')
    await expect(tokenInput).toBeVisible()
    await expect(tokenInput).toHaveAttribute('type', 'password')

    const tokenLink = page.getByRole('link', {
      name: 'Create a fine-grained personal access token',
    })
    await expect(tokenLink).toHaveAttribute(
      'href',
      'https://github.com/settings/personal-access-tokens/new',
    )
    await expect(page.getByText('Contents', { exact: true })).toBeVisible()
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible()
    await expect(page.getByText('repo', { exact: true })).toBeVisible()
    await expect(page.getByText(/organization token as pending/)).toBeVisible()

    const privateRow = page.locator('div.flex.items-start.gap-3').filter({ hasText: 'E2E Test Skillset' })
    await expect(privateRow.getByText('Private · ••••lder')).toBeVisible()
    await expect(privateRow.getByTitle('Replace or remove repository token')).toBeVisible()
    await expect(privateRow).not.toContainText('github_pat_e2e_placeholder')
  })

  test('never returns the stored token from the skillsets API', async ({ request }) => {
    const response = await request.get('/api/skillsets')
    expect(response.ok()).toBe(true)
    const body = await response.text()
    expect(body).not.toContain('github_pat_e2e_placeholder')
    expect(body).toContain('••••lder')
  })
})
