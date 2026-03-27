import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe.configure({ mode: 'serial' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openSettings(page: Page) {
  await page.locator('[data-testid="settings-button"]').click()
  await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="global-settings-dialog"]')).not.toBeVisible()
}

async function goToTab(page: Page, tabId: string) {
  await page.locator(`[data-testid="settings-nav-${tabId}"]`).click()
}

/** Click a Radix UI Select trigger and pick an option by visible text. */
async function pickSelectOption(page: Page, triggerId: string, optionText: string) {
  await page.locator(`#${triggerId}`).click()
  await page.locator('[role="option"]').filter({ hasText: optionText }).click()
}

/** Wait for a PUT /api/settings request to complete. */
async function waitForSettingsSave(page: Page) {
  await page.waitForResponse(
    (res) => res.url().includes('/api/settings') && res.request().method() === 'PUT' && res.ok(),
  )
}

// ---------------------------------------------------------------------------
// Existing tests: navigation & structure
// ---------------------------------------------------------------------------

test.describe('Settings Dialog', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('opens settings dialog via sidebar button', async ({ page }) => {
    await openSettings(page)
  })

  test('shows correct tabs for non-auth mode', async ({ page }) => {
    await openSettings(page)

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
    await openSettings(page)

    // Click LLM tab
    await goToTab(page, 'llm')
    await expect(page.locator('#llm-provider')).toBeVisible()

    // Click Runtime tab
    await goToTab(page, 'runtime')
    await expect(page.locator('#container-runner')).toBeVisible()

    // Click Browser tab
    await goToTab(page, 'browser')
    await expect(page.locator('#browser-model')).toBeVisible()

    // Click General tab
    await goToTab(page, 'general')
    await expect(page.locator('[data-testid="rerun-wizard-button"]')).toBeVisible()
  })

  test('LLM tab shows provider selector and model options', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'llm')

    await expect(page.locator('#llm-provider')).toBeVisible()
    await expect(page.locator('#agent-model')).toBeVisible()
    await expect(page.locator('#summarizer-model')).toBeVisible()
  })

  test('Runtime tab shows container config fields', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    await expect(page.locator('#container-runner')).toBeVisible()
    await expect(page.locator('#agent-image')).toBeVisible()
    await expect(page.locator('#cpu-limit')).toBeVisible()
    await expect(page.locator('#memory-limit')).toBeVisible()
    await expect(page.locator('#auto-sleep-timeout')).toBeVisible()
    await expect(page.locator('#data-location')).toBeVisible()
  })

  test('Browser tab shows browser configuration', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'browser')

    await expect(page.locator('#browser-model')).toBeVisible()
    await expect(page.locator('#max-browser-tabs')).toBeVisible()
    await expect(page.locator('#browser-host')).toBeVisible()
  })

  test('closes settings dialog', async ({ page }) => {
    await openSettings(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="global-settings-dialog"]')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Settings persistence: change a value, close, reopen, verify
// ---------------------------------------------------------------------------

test.describe('Settings persistence', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('General tab: share analytics toggle persists', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'general')

    const toggle = page.locator('#share-analytics')
    await expect(toggle).toBeVisible()

    // Read the current state, then toggle and verify persistence
    const initialState = await toggle.getAttribute('data-state')
    const oppositeState = initialState === 'checked' ? 'unchecked' : 'checked'

    // Toggle and wait for save
    const savePromise = waitForSettingsSave(page)
    await toggle.click()
    await savePromise
    await expect(toggle).toHaveAttribute('data-state', oppositeState)

    // Close, reopen, verify the toggled state persisted
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'general')
    await expect(page.locator('#share-analytics')).toHaveAttribute('data-state', oppositeState)

    // Toggle back for cleanup
    const savePromise2 = waitForSettingsSave(page)
    await page.locator('#share-analytics').click()
    await savePromise2
  })

  test('Voice tab: STT provider selection persists', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'voice')

    // If Deepgram is already selected (from a previous run), reset to OpenAI first
    const currentText = await page.locator('#stt-provider').textContent()
    if (currentText?.includes('Deepgram')) {
      const resetPromise = waitForSettingsSave(page)
      await pickSelectOption(page, 'stt-provider', 'OpenAI')
      await resetPromise
    }

    // Select Deepgram
    const savePromise = waitForSettingsSave(page)
    await pickSelectOption(page, 'stt-provider', 'Deepgram')
    await savePromise

    // The provider trigger should now show Deepgram
    await expect(page.locator('#stt-provider')).toContainText('Deepgram')

    // After selecting a provider, the API key section should appear
    await expect(page.locator('#deepgram-api-key')).toBeVisible()

    // Close, reopen, verify
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'voice')
    await expect(page.locator('#stt-provider')).toContainText('Deepgram')
    await expect(page.locator('#deepgram-api-key')).toBeVisible()
  })

  test('Browser tab: max browser tabs change persists', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'browser')

    // Change max browser tabs from default (10) to 5
    const input = page.locator('#max-browser-tabs')
    await expect(input).toHaveValue('10')

    const savePromise = waitForSettingsSave(page)
    await input.fill('5')
    await savePromise

    // Close, reopen, verify
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'browser')
    await expect(page.locator('#max-browser-tabs')).toHaveValue('5')

    // Restore default
    const restorePromise = waitForSettingsSave(page)
    await page.locator('#max-browser-tabs').fill('10')
    await restorePromise
  })

  test('Runtime tab: idle timeout change persists', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    const input = page.locator('#auto-sleep-timeout')
    // Default is 30
    await expect(input).toHaveValue('30')

    // Change to 15 — saves on blur
    await input.fill('15')
    const savePromise = waitForSettingsSave(page)
    await input.blur()
    await savePromise

    // Close, reopen, verify
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'runtime')
    await expect(page.locator('#auto-sleep-timeout')).toHaveValue('15')

    // Restore
    const restoreInput = page.locator('#auto-sleep-timeout')
    await restoreInput.fill('30')
    const restorePromise = waitForSettingsSave(page)
    await restoreInput.blur()
    await restorePromise
  })

  test('Composio tab: user ID save persists', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'composio')

    // Type a user ID
    await page.locator('#composio-user-id').fill('test-user-123')

    // Save button should appear
    const saveBtn = page.getByRole('button', { name: 'Save User ID' })
    await expect(saveBtn).toBeVisible()

    const savePromise = waitForSettingsSave(page)
    await saveBtn.click()
    await savePromise

    // After save, "Configured" badge should appear
    await expect(page.getByText('Configured', { exact: true })).toBeVisible()

    // Close, reopen, verify the badge is still there
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'composio')
    await expect(page.getByText('Configured', { exact: true })).toBeVisible()

    // Clean up: remove user ID
    const removeBtn = page.getByRole('button', { name: 'Remove User ID' })
    const removePromise = waitForSettingsSave(page)
    await removeBtn.click()
    await removePromise
  })
})

// ---------------------------------------------------------------------------
// Custom environment variables
// ---------------------------------------------------------------------------

test.describe('Custom environment variables', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('add and delete a custom env var', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // Handle the browser prompt() dialog
    page.on('dialog', async (dialog) => {
      expect(dialog.type()).toBe('prompt')
      await dialog.accept('MY_TEST_VAR')
    })

    // Click Add Variable
    const addBtn = page.getByRole('button', { name: 'Add Variable' })
    const savePromise = waitForSettingsSave(page)
    await addBtn.click()
    await savePromise

    // The variable should appear in the list (key input is disabled, shows the name)
    const keyInput = page.locator('input[disabled][value="MY_TEST_VAR"]')
    await expect(keyInput).toBeVisible()

    // Close, reopen, verify it persisted
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'runtime')
    await expect(page.locator('input[disabled][value="MY_TEST_VAR"]')).toBeVisible()

    // Delete the variable via the X button next to it
    const row = page.locator('input[disabled][value="MY_TEST_VAR"]').locator('..')
    const deletePromise = waitForSettingsSave(page)
    await row.locator('button').click()
    await deletePromise

    // Variable should be gone
    await expect(page.locator('input[disabled][value="MY_TEST_VAR"]')).not.toBeVisible()
  })

  test('edit a custom env var value', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // Add a variable first
    page.on('dialog', async (dialog) => {
      await dialog.accept('EDIT_TEST_VAR')
    })
    const addPromise = waitForSettingsSave(page)
    await page.getByRole('button', { name: 'Add Variable' }).click()
    await addPromise

    // Find the value input (sibling of the key input)
    const row = page.locator('input[disabled][value="EDIT_TEST_VAR"]').locator('..')
    const valueInput = row.locator('input:not([disabled])').first()

    // Type a value — wait for the onChange save before blurring to avoid race condition
    const fillPromise = waitForSettingsSave(page)
    await valueInput.fill('hello-world')
    await fillPromise

    // Close, reopen, verify value persisted
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'runtime')
    const persistedRow = page.locator('input[disabled][value="EDIT_TEST_VAR"]').locator('..')
    const persistedValue = persistedRow.locator('input:not([disabled])').first()
    await expect(persistedValue).toHaveValue('hello-world')

    // Clean up: delete the variable
    const deletePromise = waitForSettingsSave(page)
    await persistedRow.locator('button').click()
    await deletePromise
  })
})

// ---------------------------------------------------------------------------
// Error states & validation
// ---------------------------------------------------------------------------

test.describe('Settings validation errors', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('Runtime tab: shows error for memory below minimum', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // Memory input is disabled when agents are running — skip if disabled
    const memoryInput = page.locator('#memory-limit')
    const isDisabled = await memoryInput.isDisabled()
    test.skip(isDisabled, 'Memory input is disabled because agents are running')

    // Set memory to 100m (below 512m minimum)
    await memoryInput.fill('100m')

    // Error message should appear
    await expect(page.getByText('Memory limit must be at least 512m.')).toBeVisible()

    // Save button should be disabled (it only appears when hasChanges is true)
    const saveBtn = page.getByRole('button', { name: 'Save' })
    await expect(saveBtn).toBeVisible()
    await expect(saveBtn).toBeDisabled()
  })

  test('Runtime tab: shows error for empty agent image', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // Clear the agent image
    const imageInput = page.locator('#agent-image')
    await imageInput.fill('')

    // Error message should appear
    await expect(page.getByText('Agent image is required.')).toBeVisible()

    // Save button should be disabled
    const saveBtn = page.getByRole('button', { name: 'Save' })
    await expect(saveBtn).toBeVisible()
    await expect(saveBtn).toBeDisabled()
  })

  test('Runtime tab: save button appears only when form has changes', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // CPU input is disabled when agents are running — skip if disabled
    const cpuInput = page.locator('#cpu-limit')
    const isDisabled = await cpuInput.isDisabled()
    test.skip(isDisabled, 'CPU input is disabled because agents are running')

    // Initially no save button (no changes)
    await expect(page.getByRole('button', { name: 'Save' })).not.toBeVisible()

    // Make a change
    const originalValue = await cpuInput.inputValue()
    await cpuInput.fill('4')

    // Save and Reset buttons should now appear
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()

    // Click Reset — buttons should disappear, value restored
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(page.locator('#cpu-limit')).toHaveValue(originalValue)
    await expect(page.getByRole('button', { name: 'Save' })).not.toBeVisible()
  })

  test('handles API save failure gracefully', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // CPU input is disabled when agents are running — skip if disabled
    const cpuInput = page.locator('#cpu-limit')
    test.skip(await cpuInput.isDisabled(), 'CPU input is disabled because agents are running')

    // Make a change so Save button appears
    await cpuInput.fill('4')
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()

    // Intercept the next PUT request to simulate server error
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated server error' }),
        })
      } else {
        await route.continue()
      }
    })

    // Click Save
    await page.getByRole('button', { name: 'Save' }).click()

    // Error message should appear in the form
    await expect(page.getByText('Simulated server error')).toBeVisible()

    // Remove the route intercept so subsequent tests work
    await page.unroute('**/api/settings')
  })
})
