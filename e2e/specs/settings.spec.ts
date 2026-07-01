import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DefaultApiPolicy = 'allow' | 'review' | 'block'
type SttProvider = 'deepgram' | 'openai' | 'platform'

interface GlobalSettingsSnapshot {
  app: {
    maxBrowserTabs?: number
    autoSleepTimeoutMinutes?: number
  }
  accountProviderUserId?: string
  customEnvVars: Record<string, string>
  shareAnalytics: boolean
  voice?: {
    sttProvider?: SttProvider
  }
}

interface UserSettingsSnapshot {
  defaultApiPolicy: DefaultApiPolicy
}

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

/** Wait for a PUT /api/user-settings request to complete. */
async function waitForUserSettingsSave(page: Page) {
  await page.waitForResponse(
    (res) => res.url().includes('/api/user-settings') && res.request().method() === 'PUT' && res.ok(),
  )
}

async function settings(request: APIRequestContext) {
  const res = await request.get('/api/settings')
  expect(res.ok()).toBe(true)
  return await res.json() as GlobalSettingsSnapshot
}

async function saveSettings(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.put('/api/settings', { data })
  expect(res.ok()).toBe(true)
  return await res.json() as GlobalSettingsSnapshot
}

async function userSettings(request: APIRequestContext) {
  const res = await request.get('/api/user-settings')
  expect(res.ok()).toBe(true)
  return await res.json() as UserSettingsSnapshot
}

async function saveUserSettings(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.put('/api/user-settings', { data })
  expect(res.ok()).toBe(true)
  return await res.json() as UserSettingsSnapshot
}

async function ensureSetupCompleted(request: APIRequestContext) {
  await saveUserSettings(request, { setupCompleted: true })
}

async function setDefaultApiPolicy(request: APIRequestContext, defaultApiPolicy: DefaultApiPolicy) {
  await saveUserSettings(request, { defaultApiPolicy })
}

async function deleteCustomEnvVar(request: APIRequestContext, key: string) {
  const current = await settings(request)
  const customEnvVars = { ...current.customEnvVars }
  delete customEnvVars[key]
  await saveSettings(request, { customEnvVars })
}

function uniqueEnvKey(testInfo: TestInfo, prefix: string) {
  return `${prefix}_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.retry}_${Date.now()}`
}

function uniqueAgentName(testInfo: TestInfo, name: string) {
  return `${name} ${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${Date.now()}`
}

async function deleteAgent(request: APIRequestContext, slug: string | undefined) {
  if (!slug) return
  await request.delete(`/api/agents/${slug}`)
}

// ---------------------------------------------------------------------------
// Existing tests: navigation & structure
// ---------------------------------------------------------------------------

test.describe('Settings Page', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page, request }) => {
    await ensureSetupCompleted(request)
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

  test.beforeEach(async ({ page, request }) => {
    await ensureSetupCompleted(request)
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('General tab: share analytics toggle persists', async ({ page, request }) => {
    await saveSettings(request, { shareAnalytics: true })
    await appPage.reload()

    try {
      await openSettings(page)
      await goToTab(page, 'general')

      const toggle = page.locator('#share-analytics')
      await expect(toggle).toBeVisible()
      await expect(toggle).toHaveAttribute('data-state', 'checked')

      const savePromise = waitForSettingsSave(page)
      await toggle.click()
      await savePromise
      await expect(toggle).toHaveAttribute('data-state', 'unchecked')

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'general')
      await expect(page.locator('#share-analytics')).toHaveAttribute('data-state', 'unchecked')

      const persisted = await settings(request)
      expect(persisted.shareAnalytics).toBe(false)
    } finally {
      await saveSettings(request, { shareAnalytics: true })
    }
  })

  test('Voice tab: STT provider selection persists', async ({ page, request }) => {
    await saveSettings(request, { voice: { sttProvider: 'openai' } })
    await appPage.reload()

    try {
      await openSettings(page)
      await goToTab(page, 'voice')

      await expect(page.locator('#stt-provider')).toContainText('OpenAI')

      const savePromise = waitForSettingsSave(page)
      await pickSelectOption(page, 'stt-provider', 'Deepgram')
      await savePromise

      await expect(page.locator('#stt-provider')).toContainText('Deepgram')
      await expect(page.locator('#deepgram-api-key')).toBeVisible()

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'voice')
      await expect(page.locator('#stt-provider')).toContainText('Deepgram')
      await expect(page.locator('#deepgram-api-key')).toBeVisible()

      const persisted = await settings(request)
      expect(persisted.voice?.sttProvider).toBe('deepgram')
    } finally {
      await saveSettings(request, { voice: { sttProvider: 'openai' } })
    }
  })

  test('Browser tab: max browser tabs change persists', async ({ page, request }) => {
    await saveSettings(request, { app: { maxBrowserTabs: 10 } })
    await appPage.reload()

    try {
      await openSettings(page)
      await goToTab(page, 'browser')

      const input = page.locator('#max-browser-tabs')
      await expect(input).toHaveValue('10')

      const savePromise = waitForSettingsSave(page)
      await input.fill('5')
      await savePromise
      await expect(input).toHaveValue('5')

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'browser')
      await expect(page.locator('#max-browser-tabs')).toHaveValue('5')

      const persisted = await settings(request)
      expect(persisted.app.maxBrowserTabs).toBe(5)
    } finally {
      await saveSettings(request, { app: { maxBrowserTabs: 10 } })
    }
  })

  test('Runtime tab: idle timeout change persists', async ({ page, request }) => {
    await saveSettings(request, { app: { autoSleepTimeoutMinutes: 30 } })
    await appPage.reload()

    try {
      await openSettings(page)
      await goToTab(page, 'runtime')

      const input = page.locator('#auto-sleep-timeout')
      await expect(input).toHaveValue('30')

      await input.fill('15')
      const savePromise = waitForSettingsSave(page)
      await input.blur()
      await savePromise

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'runtime')
      await expect(page.locator('#auto-sleep-timeout')).toHaveValue('15')

      const persisted = await settings(request)
      expect(persisted.app.autoSleepTimeoutMinutes).toBe(15)
    } finally {
      await saveSettings(request, { app: { autoSleepTimeoutMinutes: 30 } })
    }
  })

  test('Composio tab: user ID save persists', async ({ page, request }, testInfo) => {
    const userId = `settings-user-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}-${Date.now()}`
    await saveSettings(request, { apiKeys: { accountProviderUserId: '' } })
    await appPage.reload()

    try {
      await openSettings(page)
      await goToTab(page, 'account-provider')

      await page.locator('#provider-user-id').fill(userId)

      const saveBtn = page.getByRole('button', { name: 'Save User ID' })
      await expect(saveBtn).toBeVisible()

      const savePromise = waitForSettingsSave(page)
      await saveBtn.click()
      await savePromise

      await expect(page.getByText('Configured', { exact: true })).toBeVisible()

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'account-provider')
      await expect(page.getByText('Configured', { exact: true })).toBeVisible()

      const persisted = await settings(request)
      expect(persisted.accountProviderUserId).toBe(userId)

      const removeBtn = page.getByRole('button', { name: 'Remove User ID' })
      const removePromise = waitForSettingsSave(page)
      await removeBtn.click()
      await removePromise
      await expect(page.getByText('Configured', { exact: true })).not.toBeVisible()

      const cleaned = await settings(request)
      expect(cleaned.accountProviderUserId).toBeUndefined()
    } finally {
      await saveSettings(request, { apiKeys: { accountProviderUserId: '' } })
    }
  })

  test('Connections tab: global default API policy toggle persists', async ({ page, request }) => {
    await setDefaultApiPolicy(request, 'review')
    await appPage.reload()

    try {
      await openSettings(page)
      await goToTab(page, 'connections')

      // The API default-policy row inside the "Default Policies" card.
      const globalSection = page.locator('[data-testid="default-policy-api"]')
      const reviewToggle = globalSection.locator('[data-testid="policy-toggle-review"]')
      const allowToggle = globalSection.locator('[data-testid="policy-toggle-allow"]')

      // Review is default, should be active.
      await expect(reviewToggle).toHaveAttribute('data-active', 'true')
      await expect(allowToggle).toHaveAttribute('data-active', 'false')

      // Switch to allow and wait for the user-settings mutation.
      const savePromise = waitForUserSettingsSave(page)
      await allowToggle.click()
      await savePromise
      await expect(allowToggle).toHaveAttribute('data-active', 'true')
      await expect(reviewToggle).toHaveAttribute('data-active', 'false')

      // Close, reopen, verify the persisted setting is reflected by the UI.
      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'connections')
      const reopenedSection = page.locator('[data-testid="default-policy-api"]')
      await expect(reopenedSection.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true')
      await expect(reopenedSection.locator('[data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'false')

      const persisted = await userSettings(request)
      expect(persisted.defaultApiPolicy).toBe('allow')
    } finally {
      await setDefaultApiPolicy(request, 'review')
    }
  })
})

// ---------------------------------------------------------------------------
// Custom environment variables
// ---------------------------------------------------------------------------

test.describe('Custom environment variables', () => {
  test.beforeEach(async ({ page, request }) => {
    await ensureSetupCompleted(request)
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('add, edit, persist, and delete a custom env var', async ({ page, request }, testInfo) => {
    const envKey = uniqueEnvKey(testInfo, 'SETTINGS_TEST_VAR')
    await deleteCustomEnvVar(request, envKey)

    try {
      await openSettings(page)
      await goToTab(page, 'runtime')

      await page.getByRole('button', { name: 'Add Variable' }).click()
      const dialog = page.getByRole('dialog').filter({ hasText: 'Add Custom Environment Variable' })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Variable Name').fill(envKey)

      const addPromise = waitForSettingsSave(page)
      await dialog.getByRole('button', { name: 'Add Variable' }).click()
      await addPromise

      const row = page.locator(`[data-testid="custom-env-var-row"][data-env-var-key="${envKey}"]`)
      await expect(row.getByTestId('custom-env-var-key')).toHaveValue(envKey)

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'runtime')
      const reopenedRow = page.locator(`[data-testid="custom-env-var-row"][data-env-var-key="${envKey}"]`)
      await expect(reopenedRow.getByTestId('custom-env-var-key')).toHaveValue(envKey)

      const valueInput = reopenedRow.getByTestId('custom-env-var-value')
      await valueInput.fill('hello-world')
      const editPromise = waitForSettingsSave(page)
      await valueInput.blur()
      await editPromise

      const edited = await settings(request)
      expect(edited.customEnvVars[envKey]).toBe('hello-world')

      await closeSettings(page)
      await openSettings(page)
      await goToTab(page, 'runtime')
      const persistedRow = page.locator(`[data-testid="custom-env-var-row"][data-env-var-key="${envKey}"]`)
      await expect(persistedRow.getByTestId('custom-env-var-value')).toHaveValue('hello-world')

      const deletePromise = waitForSettingsSave(page)
      await persistedRow.getByTestId('custom-env-var-delete').click()
      await deletePromise

      await expect(page.locator(`[data-testid="custom-env-var-row"][data-env-var-key="${envKey}"]`)).not.toBeVisible()
      const cleaned = await settings(request)
      expect(cleaned.customEnvVars[envKey]).toBeUndefined()
    } finally {
      await deleteCustomEnvVar(request, envKey)
    }
  })
})

// ---------------------------------------------------------------------------
// Error states & validation
// ---------------------------------------------------------------------------

test.describe('Settings validation errors', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page, request }) => {
    await ensureSetupCompleted(request)
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
  test('voice-button deep link does not stick after close', async ({ page, request }, testInfo) => {
    await ensureSetupCompleted(request)
    let agent: { slug: string; displaySlug: string } | undefined

    try {
      const createRes = await request.post('/api/agents', {
        data: { name: uniqueAgentName(testInfo, 'Voice Deep Link Test') },
      })
      agent = await createRes.json() as { slug: string; displaySlug: string }

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
    } finally {
      await deleteAgent(request, agent?.slug)
    }
  })
})

// ---------------------------------------------------------------------------
// Settings is a route; close pushes back to the captured ?from= origin (a
// durable query param, not history.back), or home on a cold deep-link.
// ---------------------------------------------------------------------------

test.describe('Settings ?from= close-target', () => {
  test('close pushes to the captured ?from origin', async ({ page, request }, testInfo) => {
    await ensureSetupCompleted(request)
    let agent: { slug: string; displaySlug: string } | undefined

    try {
      const createRes = await request.post('/api/agents', { data: { name: uniqueAgentName(testInfo, 'Settings From Origin') } })
      agent = await createRes.json() as { slug: string; displaySlug: string }

      const appPage = new AppPage(page)
      await appPage.goto()
      await appPage.waitForAgentsLoaded()
      await page.locator(`[data-testid="agent-item-${agent.slug}"]`).click()
      // The URL carries the display slug ({name}-{id}), not the bare canonical id.
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.displaySlug}$`))
      const origin = page.url()

      await page.locator('[data-testid="settings-button"]').click()
      await expect(page).toHaveURL(/\/settings(\/|\?|$)/)
      await page.locator('[data-testid="settings-back"]').click()
      await expect(page).toHaveURL(origin)
    } finally {
      await deleteAgent(request, agent?.slug)
    }
  })

  test('cold deep-link to /settings/general closes to home (no ?from)', async ({ page, request }) => {
    await ensureSetupCompleted(request)
    await page.goto('/settings/general')
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await expect(page.locator('[data-testid="settings-nav-general"]')).toHaveAttribute('data-active', 'true')
    await page.locator('[data-testid="settings-back"]').click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('settings survives a refresh and still closes to origin (?from= is durable)', async ({ page, request }, testInfo) => {
    await ensureSetupCompleted(request)
    let agent: { slug: string; displaySlug: string } | undefined

    try {
      const createRes = await request.post('/api/agents', { data: { name: uniqueAgentName(testInfo, 'Settings Refresh From') } })
      agent = await createRes.json() as { slug: string; displaySlug: string }

      const appPage = new AppPage(page)
      await appPage.goto()
      await appPage.waitForAgentsLoaded()
      await page.locator(`[data-testid="agent-item-${agent.slug}"]`).click()
      // The URL carries the display slug ({name}-{id}), not the bare canonical id.
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.displaySlug}$`))
      const origin = page.url()

      await page.locator('[data-testid="settings-button"]').click()
      await expect(page).toHaveURL(/\/settings(\/|\?|$)/)
      await page.reload()
      await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
      await page.locator('[data-testid="settings-back"]').click()
      await expect(page).toHaveURL(origin)
    } finally {
      await deleteAgent(request, agent?.slug)
    }
  })
})
