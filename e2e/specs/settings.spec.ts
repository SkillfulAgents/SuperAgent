import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe.configure({ mode: 'serial' })

test.describe('Settings Dialog', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('opens settings dialog via sidebar button', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
  })

  test('shows correct tabs for non-auth mode', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()

    // User tabs (visible to all)
    await expect(page.locator('[data-testid="settings-nav-general"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-notifications"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-accounts"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-remote-mcps"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-usage"]')).toBeVisible()

    // Admin tabs (visible in non-auth mode)
    await expect(page.locator('[data-testid="settings-nav-llm"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-runtime"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-browser"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-composio"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-voice"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-skillsets"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-admin"]')).toBeVisible()

    // Auth-only tabs should NOT be visible in non-auth mode
    await expect(page.locator('[data-testid="settings-nav-profile"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-users"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-auth"]')).not.toBeVisible()
  })

  test('navigates between settings tabs', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()

    // Click LLM tab
    await page.locator('[data-testid="settings-nav-llm"]').click()
    await expect(page.locator('#llm-provider')).toBeVisible()

    // Click Runtime tab
    await page.locator('[data-testid="settings-nav-runtime"]').click()
    await expect(page.locator('#container-runner')).toBeVisible()

    // Click Browser tab
    await page.locator('[data-testid="settings-nav-browser"]').click()
    await expect(page.locator('#browser-model')).toBeVisible()

    // Click General tab
    await page.locator('[data-testid="settings-nav-general"]').click()
    await expect(page.locator('[data-testid="rerun-wizard-button"]')).toBeVisible()
  })

  test('LLM tab shows provider selector and model options', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await page.locator('[data-testid="settings-nav-llm"]').click()

    // Provider selector should be visible
    await expect(page.locator('#llm-provider')).toBeVisible()

    // Model selectors should be visible
    await expect(page.locator('#agent-model')).toBeVisible()
    await expect(page.locator('#summarizer-model')).toBeVisible()
  })

  test('Runtime tab shows container config fields', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await page.locator('[data-testid="settings-nav-runtime"]').click()

    // Container runner selector
    await expect(page.locator('#container-runner')).toBeVisible()

    // Agent image field
    await expect(page.locator('#agent-image')).toBeVisible()

    // Resource limits
    await expect(page.locator('#cpu-limit')).toBeVisible()
    await expect(page.locator('#memory-limit')).toBeVisible()

    // Idle timeout
    await expect(page.locator('#auto-sleep-timeout')).toBeVisible()

    // Data location (read-only)
    await expect(page.locator('#data-location')).toBeVisible()
  })

  test('Browser tab shows browser configuration', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await page.locator('[data-testid="settings-nav-browser"]').click()

    // Browser model selector
    await expect(page.locator('#browser-model')).toBeVisible()

    // Max browser tabs
    await expect(page.locator('#max-browser-tabs')).toBeVisible()

    // Browser host selector
    await expect(page.locator('#browser-host')).toBeVisible()
  })

  test('closes settings dialog', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()

    // Close via Escape key
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="global-settings-dialog"]')).not.toBeVisible()
  })
})
