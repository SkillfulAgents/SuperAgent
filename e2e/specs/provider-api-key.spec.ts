/**
 * Provider API key lifecycle on the LLM settings tab — validate & save,
 * invalid-key inline error, remove — cross-checked against the sidebar
 * "No API key configured" warning and the settings API.
 *
 * Runs in the quarantined wizard config (single worker, own data dir): a
 * saved key is global server state, and the fully-parallel main suite is
 * deliberately keyless. Key validation is route-mocked — the real
 * /api/settings/validate-llm-key fires an actual Anthropic API call.
 *
 * The sidebar (and its warning) only exists on the app shell: Settings is a
 * top-level sibling route that replaces the whole shell, so the warning
 * cross-checks happen on `/`.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe.configure({ mode: 'serial' })

const GOOD_KEY = 'sk-ant-e2e-valid-key'
const BAD_KEY = 'sk-ant-e2e-invalid-key'

interface KeyStatus {
  isConfigured: boolean
  source: string
}

async function getAnthropicKeyStatus(request: APIRequestContext): Promise<KeyStatus> {
  const response = await request.get('/api/settings')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { apiKeyStatus: { anthropic: KeyStatus } }
  return body.apiKeyStatus.anthropic
}

/** The sidebar ApiKeyWarning — "Click to set up" only appears there. */
function sidebarWarning(page: Page) {
  return page.getByText('Click to set up')
}

function keyInput(page: Page) {
  return page.locator('#anthropic-api-key')
}

/** Mock the validation endpoint (the real one calls Anthropic). */
async function mockValidation(page: Page, result: { valid: boolean; error?: string }) {
  await page.route('**/api/settings/validate-llm-key', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(result),
    })
  })
}

async function gotoLlmSettings(page: Page) {
  await page.goto('/settings/llm')
  await expect(keyInput(page)).toBeVisible({ timeout: 15000 })
}

test.describe('Provider API key lifecycle', () => {
  test.beforeEach(async ({ request }) => {
    // Keyless, onboarded baseline. The wizard spec shares this server and
    // toggles onboarding state, so re-establish both defensively.
    await request.put('/api/user-settings', { data: { setupCompleted: true } })
    await request.put('/api/settings', {
      data: { app: { setupCompleted: true }, apiKeys: { anthropicApiKey: '' } },
    })
  })

  test.afterEach(async ({ request }) => {
    await request.put('/api/settings', { data: { apiKeys: { anthropicApiKey: '' } } })
  })

  test('keyless sidebar warning deep-links to the LLM settings tab', async ({ page }) => {
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAppLoaded()

    await expect(sidebarWarning(page)).toBeVisible({ timeout: 15000 })
    await sidebarWarning(page).click()

    await expect(page).toHaveURL(/\/settings\/llm/)
    await expect(keyInput(page)).toBeVisible({ timeout: 15000 })
  })

  test('invalid key shows the inline error and saves nothing', async ({ page, request }) => {
    await mockValidation(page, { valid: false, error: 'Invalid API key: 401 unauthorized' })
    await gotoLlmSettings(page)

    await keyInput(page).fill(BAD_KEY)
    await page.getByRole('button', { name: 'Validate & Save' }).click()

    await expect(page.getByText('Invalid API key: 401 unauthorized')).toBeVisible()
    // The input keeps the rejected key for correction rather than clearing it.
    await expect(keyInput(page)).toHaveValue(BAD_KEY)

    expect(await getAnthropicKeyStatus(request)).toEqual({ isConfigured: false, source: 'none' })
  })

  test('valid key saves and clears the warning; removing restores it', async ({ page, request }) => {
    await mockValidation(page, { valid: true })
    await gotoLlmSettings(page)

    await keyInput(page).fill(GOOD_KEY)
    await page.getByRole('button', { name: 'Validate & Save' }).click()

    // Saved state: success note, source pill, and the input resets.
    await expect(page.getByText('API key is valid and has been saved.')).toBeVisible()
    await expect(page.getByText('Using saved setting')).toBeVisible()
    await expect(keyInput(page)).toHaveValue('')
    await expect.poll(async () => getAnthropicKeyStatus(request)).toEqual({
      isConfigured: true,
      source: 'settings',
    })

    // Settings PUT contract: a payload without apiKeys must keep the key
    // (only an explicit empty string deletes).
    const putRes = await request.put('/api/settings', { data: { llmProvider: 'anthropic' } })
    expect(putRes.ok()).toBeTruthy()
    expect(await getAnthropicKeyStatus(request)).toEqual({ isConfigured: true, source: 'settings' })

    // The sidebar warning is gone once a key is configured.
    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await expect(sidebarWarning(page)).toHaveCount(0)

    // Remove the saved key through the confirm dialog.
    await gotoLlmSettings(page)
    await page.getByRole('button', { name: 'Remove Saved Key' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()

    await expect(page.getByRole('button', { name: 'Remove Saved Key' })).toHaveCount(0)
    await expect.poll(async () => getAnthropicKeyStatus(request)).toEqual({
      isConfigured: false,
      source: 'none',
    })

    // And the warning returns.
    await appPage.goto()
    await appPage.waitForAppLoaded()
    await expect(sidebarWarning(page)).toBeVisible({ timeout: 15000 })
  })
})
