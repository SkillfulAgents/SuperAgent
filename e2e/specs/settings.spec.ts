import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe.configure({ mode: 'serial' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openSettings(page: Page) {
  await page.locator('[data-testid="settings-button"]').click()
  await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
}

async function closeSettings(page: Page) {
  await page.locator('[data-testid="settings-back"]').click()
  await expect(page.locator('[data-testid="global-settings-page"]')).not.toBeVisible()
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

test.describe('Settings Page', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('opens settings page via sidebar button', async ({ page }) => {
    await openSettings(page)
    await expect(page).toHaveURL(/\/settings/)
  })

  test('shows correct tabs for non-auth mode', async ({ page }) => {
    await openSettings(page)

    // User tabs (visible to all)
    await expect(page.locator('[data-testid="settings-nav-general"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-notifications"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-connections"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-usage"]')).toBeVisible()

    // Admin tabs (visible in non-auth mode)
    await expect(page.locator('[data-testid="settings-nav-llm"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-runtime"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-browser"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-account-provider"]')).toBeVisible()
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
    await expect(page.locator('[data-testid="llm-provider-card-anthropic"]')).toBeVisible()

    // Click Runtime tab
    await goToTab(page, 'runtime')
    await expect(page.locator('#container-runner')).toBeVisible()

    // Click Browser tab
    await goToTab(page, 'browser')
    await expect(page.locator('[data-testid="settings-model-trigger"]')).toBeVisible()

    // Click General tab
    await goToTab(page, 'general')
    await expect(page.locator('[data-testid="rerun-wizard-button"]')).toBeVisible()
  })

  test('LLM tab shows provider selector and model options', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'llm')

    // Provider radio cards replace the old <select>; the active provider's card
    // expands inline to show its three model selectors (default + summarizer + dashboard).
    await expect(page.locator('[data-testid="llm-provider-card-anthropic"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-model-trigger"]')).toHaveCount(3)
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

    await expect(page.locator('[data-testid="settings-model-trigger"]')).toBeVisible()
    await expect(page.locator('#max-browser-tabs')).toBeVisible()
    await expect(page.locator('#browser-host')).toBeVisible()
  })

  test('closes settings page', async ({ page }) => {
    await openSettings(page)
    await page.locator('[data-testid="settings-back"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).not.toBeVisible()
    await expect(page).not.toHaveURL(/\/settings/)
  })

  test('switching tabs drives the URL', async ({ page }) => {
    await openSettings(page)
    // The tab navigates to /settings/$tab, preserving the ?from= close-target
    // captured at open (hence the `(\?|$)` — the URL keeps `?from=/`).
    await page.locator('[data-testid="settings-nav-runtime"]').click()
    await expect(page).toHaveURL(/\/settings\/runtime(\?|$)/)
    await page.locator('[data-testid="settings-nav-voice"]').click()
    await expect(page).toHaveURL(/\/settings\/voice(\?|$)/)
  })

  test('an unknown settings tab redirects to /settings', async ({ page }) => {
    await page.goto('/settings/totally-not-a-tab')
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await expect(page).toHaveURL(/\/settings(\?|$)/)
  })

  test('app shell unmounts while settings is open and returns on close', async ({ page }) => {
    // App sidebar visible before opening settings
    await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible()

    await openSettings(page)
    // App sidebar (and its Settings button) is gone; the settings sidebar replaces it
    await expect(page.locator('[data-testid="app-sidebar"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="settings-button"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="settings-sidebar"]')).toBeVisible()

    await page.locator('[data-testid="settings-back"]').click()
    // App sidebar returns
    await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-sidebar"]')).not.toBeVisible()
  })

  test('non-auth mode shows ungrouped sections (no group labels)', async ({ page }) => {
    await openSettings(page)
    // Group labels are only rendered in auth+admin mode; in non-auth mode the sidebar is flat.
    await expect(page.locator('[data-sidebar="group-label"]')).toHaveCount(0)
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
    await goToTab(page, 'account-provider')

    // Type a user ID
    await page.locator('#provider-user-id').fill('test-user-123')

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
    await goToTab(page, 'account-provider')
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

    await page.getByRole('button', { name: 'Add Variable' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Add Custom Environment Variable' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Variable Name').fill('MY_TEST_VAR')

    const savePromise = waitForSettingsSave(page)
    await dialog.getByRole('button', { name: 'Add Variable' }).click()
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
    const row = page.locator('[data-testid="custom-env-var-row"][data-env-var-key="MY_TEST_VAR"]')
    const deletePromise = waitForSettingsSave(page)
    await row.getByTestId('custom-env-var-delete').click()
    await deletePromise

    // Variable should be gone
    await expect(page.locator('input[disabled][value="MY_TEST_VAR"]')).not.toBeVisible()
  })

  test('edit a custom env var value', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    await page.getByRole('button', { name: 'Add Variable' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Add Custom Environment Variable' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Variable Name').fill('EDIT_TEST_VAR')

    const addPromise = waitForSettingsSave(page)
    await dialog.getByRole('button', { name: 'Add Variable' }).click()
    await addPromise

    // Find the value input (sibling of the key input)
    const row = page.locator('[data-testid="custom-env-var-row"][data-env-var-key="EDIT_TEST_VAR"]')
    const valueInput = row.getByTestId('custom-env-var-value')

    // Persist on blur, matching the runtime tab behavior.
    await valueInput.fill('hello-world')
    const fillPromise = waitForSettingsSave(page)
    await valueInput.blur()
    await fillPromise

    // Close, reopen, verify value persisted
    await closeSettings(page)
    await openSettings(page)
    await goToTab(page, 'runtime')
    const persistedRow = page.locator('[data-testid="custom-env-var-row"][data-env-var-key="EDIT_TEST_VAR"]')
    const persistedValue = persistedRow.getByTestId('custom-env-var-value')
    await expect(persistedValue).toHaveValue('hello-world')

    // Clean up: delete the variable
    const deletePromise = waitForSettingsSave(page)
    await persistedRow.getByTestId('custom-env-var-delete').click()
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

  test('Runtime tab: memory dropdown does not offer values below 512m', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // Memory dropdown is disabled when agents are running — skip if disabled
    const memoryTrigger = page.locator('#memory-limit')
    const isDisabled = await memoryTrigger.isDisabled()
    test.skip(isDisabled, 'Memory dropdown is disabled because agents are running')

    await memoryTrigger.click()

    // The smallest option must be 512 MB — no sub-minimum values like 128 MB / 256 MB.
    const options = page.getByRole('option')
    await expect(options.first()).toHaveText('512 MB')
    await expect(page.getByRole('option', { name: '128 MB' })).toHaveCount(0)
    await expect(page.getByRole('option', { name: '256 MB' })).toHaveCount(0)
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

    // CPU dropdown is disabled when agents are running — skip if disabled
    const cpuTrigger = page.locator('#cpu-limit')
    const isDisabled = await cpuTrigger.isDisabled()
    test.skip(isDisabled, 'CPU dropdown is disabled because agents are running')

    // Initially no save button (no changes)
    await expect(page.getByRole('button', { name: 'Save' })).not.toBeVisible()

    // Capture the current selection text ("1 core", "2 cores", etc.) and pick
    // a different option from the dropdown.
    const originalText = (await cpuTrigger.textContent())?.trim() ?? ''
    const targetOption = originalText.startsWith('4') ? '2 cores' : '4 cores'

    await cpuTrigger.click()
    await page.getByRole('option', { name: targetOption }).click()

    // Save and Reset buttons should now appear
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()

    // Click Reset — buttons should disappear, value restored
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(cpuTrigger).toHaveText(originalText)
    await expect(page.getByRole('button', { name: 'Save' })).not.toBeVisible()
  })

  test('handles API save failure gracefully', async ({ page }) => {
    await openSettings(page)
    await goToTab(page, 'runtime')

    // CPU dropdown is disabled when agents are running — skip if disabled
    const cpuTrigger = page.locator('#cpu-limit')
    test.skip(await cpuTrigger.isDisabled(), 'CPU dropdown is disabled because agents are running')

    // Make a change so Save button appears — pick an option different from the current one
    const originalText = (await cpuTrigger.textContent())?.trim() ?? ''
    const targetOption = originalText.startsWith('4') ? '2 cores' : '4 cores'
    await cpuTrigger.click()
    await page.getByRole('option', { name: targetOption }).click()
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

// ---------------------------------------------------------------------------
// Deep-link reset: tab targets clear when settings closes so the next plain
// open lands on the default section.
// ---------------------------------------------------------------------------

test.describe('Settings deep-link reset', () => {
  test('voice-button deep link does not stick after close', async ({ page, request }) => {
    // Skip the first-launch wizard so the app renders straight to the agent view.
    await request.put('/api/user-settings', {
      data: { setupCompleted: true },
    })
    // Seed an agent via API so the home message-input (which hosts the voice button) renders.
    const createRes = await request.post('/api/agents', {
      data: { name: 'Voice Deep Link Test' },
    })
    const agent = await createRes.json() as { slug: string }

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await page.locator(`[data-testid="agent-item-${agent.slug}"]`).click()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Voice provider is unconfigured in mock mode → clicking the mic deep-links to the Voice section.
    await page.locator('[data-testid="voice-input-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-voice"]')).toHaveAttribute('data-active', 'true')

    // Close, then reopen via the plain Settings button (no tab argument).
    await page.locator('[data-testid="settings-back"]').click()
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()

    // Should land on the default first section, NOT remember 'voice'.
    await expect(page.locator('[data-testid="settings-nav-general"]')).toHaveAttribute('data-active', 'true')
    await expect(page.locator('[data-testid="settings-nav-voice"]')).toHaveAttribute('data-active', 'false')

    // Clean up: delete the seeded agent via API so other tests aren't affected.
    await request.delete(`/api/agents/${agent.slug}`)
  })
})

// ---------------------------------------------------------------------------
// Settings is a route; close pushes back to the captured ?from= origin (a
// durable query param, not history.back), or home on a cold deep-link.
// ---------------------------------------------------------------------------

test.describe('Settings ?from= close-target', () => {
  test('close pushes to the captured ?from origin', async ({ page, request }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: true } })
    const createRes = await request.post('/api/agents', { data: { name: 'Settings From Origin' } })
    const agent = await createRes.json() as { slug: string }

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await page.locator(`[data-testid="agent-item-${agent.slug}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}$`))
    const origin = page.url()

    await page.locator('[data-testid="settings-button"]').click()
    await expect(page).toHaveURL(/\/settings(\/|\?|$)/)
    await page.locator('[data-testid="settings-back"]').click()
    await expect(page).toHaveURL(origin)

    await request.delete(`/api/agents/${agent.slug}`)
  })

  test('cold deep-link to /settings/general closes to home (no ?from)', async ({ page, request }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: true } })
    await page.goto('/settings/general')
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-general"]')).toHaveAttribute('data-active', 'true')
    await page.locator('[data-testid="settings-back"]').click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('settings survives a refresh and still closes to origin (?from= is durable)', async ({ page, request }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: true } })
    const createRes = await request.post('/api/agents', { data: { name: 'Settings Refresh From' } })
    const agent = await createRes.json() as { slug: string }

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await page.locator(`[data-testid="agent-item-${agent.slug}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}$`))
    const origin = page.url()

    await page.locator('[data-testid="settings-button"]').click()
    await expect(page).toHaveURL(/\/settings(\/|\?|$)/)
    await page.reload()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-back"]').click()
    await expect(page).toHaveURL(origin)

    await request.delete(`/api/agents/${agent.slug}`)
  })
})
