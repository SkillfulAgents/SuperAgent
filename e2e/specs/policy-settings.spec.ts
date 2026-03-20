import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe.configure({ mode: 'serial' })

test.describe('Policy Settings', () => {
  let appPage: AppPage
  let accountId: string

  test.beforeAll(async ({ request }) => {
    // Seed a connected account via API so the settings tab has something to show
    const res = await request.post('/api/connected-accounts', {
      data: {
        composioConnectionId: 'e2e-test-connection',
        toolkitSlug: 'slack',
        displayName: 'E2E Slack Account',
      },
    })
    const body = await res.json()
    accountId = body.account.id
  })

  test('settings: accounts tab shows policy pill for connected account', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open global settings
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()

    // Navigate to Accounts tab
    await page.locator('[data-testid="settings-nav-accounts"]').click()

    // Should see the policy pill for our account (no policies yet)
    const pill = page.locator(`[data-testid="policy-pill-${accountId}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    await expect(pill).toContainText('No policies')
  })

  test('settings: can open scope policy editor and set a policy', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Accounts
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-accounts"]').click()

    // Click the policy pill to open scope editor
    const pill = page.locator(`[data-testid="policy-pill-${accountId}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    await pill.click()

    // Scope policy editor dialog should open
    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })

    // Find the chat:write scope row and set it to "allow"
    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })

    // The allow toggle should not be active
    const allowToggle = chatWriteRow.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'false')

    // Click the allow toggle
    await allowToggle.click()
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    // Save
    await page.locator('[data-testid="scope-policy-save"]').click()

    // Dialog should close
    await expect(page.getByText('Scope Policies')).not.toBeVisible({ timeout: 5000 })

    // The pill should now show "1" for the allow count (no longer "No policies")
    await expect(pill).not.toContainText('No policies', { timeout: 5000 })
  })

  test('settings: saved policy persists after reopening editor', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Accounts
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-accounts"]').click()

    // Open the policy editor again
    const pill = page.locator(`[data-testid="policy-pill-${accountId}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    await pill.click()

    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })

    // The chat:write scope should still have allow active (from previous test)
    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })
    const allowToggle = chatWriteRow.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'true')
  })

  test('settings: can change policy from allow to block', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Accounts → scope editor
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-accounts"]').click()

    const pill = page.locator(`[data-testid="policy-pill-${accountId}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    await pill.click()
    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })

    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })

    // Allow should be active from previous test
    const allowToggle = chatWriteRow.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    // Click block toggle instead
    const blockToggle = chatWriteRow.locator('[data-testid="policy-toggle-block"]')
    await blockToggle.click()

    // Allow should now be inactive, block active
    await expect(allowToggle).toHaveAttribute('data-active', 'false')
    await expect(blockToggle).toHaveAttribute('data-active', 'true')

    // Save
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect(page.getByText('Scope Policies')).not.toBeVisible({ timeout: 5000 })
  })

  test('settings: can deselect to reset to default', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Accounts → scope editor
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-accounts"]').click()

    const pill = page.locator(`[data-testid="policy-pill-${accountId}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    await pill.click()
    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })

    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })

    // Block should be active from previous test
    const blockToggle = chatWriteRow.locator('[data-testid="policy-toggle-block"]')
    await expect(blockToggle).toHaveAttribute('data-active', 'true')

    // Click block again to deselect (reset to default)
    await blockToggle.click()
    await expect(blockToggle).toHaveAttribute('data-active', 'false')

    // All toggles should be inactive (= default)
    await expect(chatWriteRow.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'false')
    await expect(chatWriteRow.locator('[data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'false')
    await expect(chatWriteRow.locator('[data-testid="policy-toggle-block"]')).toHaveAttribute('data-active', 'false')

    // Save and verify pill goes back to "No policies"
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect(page.getByText('Scope Policies')).not.toBeVisible({ timeout: 5000 })
    await expect(pill).toContainText('No policies', { timeout: 5000 })
  })

  test('settings: global default policy toggle works', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Accounts
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-accounts"]').click()

    // Find the global default policy section — the border div containing the label
    const globalSection = page.locator('div.border').filter({ hasText: 'Default API Request Policy' })
    const reviewToggle = globalSection.locator('[data-testid="policy-toggle-review"]')
    const allowToggle = globalSection.locator('[data-testid="policy-toggle-allow"]')

    // Review is default, should be active
    await expect(reviewToggle).toHaveAttribute('data-active', 'true')

    // Switch to allow
    await allowToggle.click()
    await expect(allowToggle).toHaveAttribute('data-active', 'true')
    await expect(reviewToggle).toHaveAttribute('data-active', 'false')
  })
})
