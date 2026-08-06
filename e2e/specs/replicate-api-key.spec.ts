/**
 * Replicate BYOK key entry on Settings → Media Generation.
 * Quarantined with provider-api-key (mutates global apiKeys state).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const GOOD_KEY = 'r8_e2e_valid_key'
const BAD_KEY = 'r8_e2e_invalid_key'

interface KeyStatus {
  isConfigured: boolean
  source: string
}

async function getReplicateKeyStatus(request: APIRequestContext): Promise<KeyStatus> {
  const response = await request.get('/api/settings')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { apiKeyStatus: { replicate: KeyStatus } }
  return body.apiKeyStatus.replicate
}

function keyInput(page: Page) {
  return page.locator('#replicate-api-key')
}

async function mockValidation(page: Page, result: { valid: boolean; error?: string }) {
  await page.route('**/api/settings/validate-replicate-key', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(result),
    })
  })
}

async function clearReplicateKey(request: APIRequestContext) {
  await request.put('/api/settings', { data: { apiKeys: { replicateApiKey: '' } } })
}

async function gotoMediaSettings(page: Page) {
  await page.goto('/settings/media')
  await expect(keyInput(page)).toBeVisible({ timeout: 15000 })
}

test.describe.configure({ mode: 'serial' })

test.describe('Replicate API key (Media Generation)', () => {
  test.beforeEach(async ({ request }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: true } })
    await request.put('/api/settings', {
      data: { app: { setupCompleted: true }, apiKeys: { replicateApiKey: '' } },
    })
  })

  test.afterEach(async ({ request }) => {
    await clearReplicateKey(request)
  })

  test('invalid key shows the inline error and saves nothing', async ({ page, request }) => {
    await mockValidation(page, { valid: false, error: 'Invalid API key' })
    await gotoMediaSettings(page)

    await keyInput(page).fill(BAD_KEY)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.getByText('Invalid API key')).toBeVisible()
    expect(await getReplicateKeyStatus(request)).toEqual({ isConfigured: false, source: 'none' })
  })

  test('valid key saves and shows configured state', async ({ page, request }) => {
    await mockValidation(page, { valid: true })
    await gotoMediaSettings(page)

    await keyInput(page).fill(GOOD_KEY)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.getByText('API key is valid and has been saved.')).toBeVisible()
    await expect(page.getByText('Using saved setting')).toBeVisible()
    await expect.poll(async () => getReplicateKeyStatus(request)).toEqual({
      isConfigured: true,
      source: 'settings',
    })
  })
})
