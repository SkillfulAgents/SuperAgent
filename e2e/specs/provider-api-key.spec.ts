/** Connection configuration uses mocked validation; no provider API is called. */
import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'

test.describe.configure({ mode: 'serial' })

async function mockValidation(page: Page, result: { valid: boolean; error?: string }) {
  await page.route('**/api/llm-connections/validate', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(result),
    })
  )
}
async function addForm(page: Page) {
  await page.goto('/settings/llm')
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.getByLabel('API key', { exact: true })).toBeVisible()
}

test.describe('Provider connection lifecycle', () => {
  test.beforeEach(async ({ request }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: true } })
    await request.put('/api/settings', {
      data: { app: { setupCompleted: true }, apiKeys: { anthropicApiKey: '' } },
    })
  })

  test('keyless sidebar warning still deep-links to model settings', async ({ page }) => {
    const app = new AppPage(page)
    await app.goto()
    await app.waitForAppLoaded()
    await page.getByText('Click to set up').click()
    await expect(page).toHaveURL(/\/settings\/llm/)
    await expect(page.getByRole('button', { name: 'Add connection', exact: true })).toBeVisible()
  })

  test('draft validation keeps a rejected key editable and saves nothing', async ({
    page,
    request,
  }) => {
    const before = await (await request.get('/api/llm-connections')).json()
    await mockValidation(page, { valid: false, error: 'Invalid test key' })
    await addForm(page)
    await page.getByLabel('Name', { exact: true }).fill('Rejected account')
    await page.getByLabel('API key', { exact: true }).fill('invalid-test-key')
    await page.getByRole('button', { name: 'Validate', exact: true }).click()
    await expect(page.getByText('Invalid test key', { exact: true })).toBeVisible()
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('invalid-test-key')
    const after = await (await request.get('/api/llm-connections')).json()
    expect(after.connections).toHaveLength(before.connections.length)
  })

  test('adds two accounts without changing the default, switches explicitly, and protects the root', async ({
    page,
    request,
  }) => {
    const before = await (await request.get('/api/llm-connections')).json()
    await mockValidation(page, { valid: true })
    for (const name of ['First test account', 'Second test account']) {
      await addForm(page)
      await page.getByLabel('Name', { exact: true }).fill(name)
      await page.getByLabel('API key', { exact: true }).fill('sk-ant-e2e-placeholder')
      await page.getByRole('button', { name: 'Validate', exact: true }).click()
      await expect(page.getByText('Connection works', { exact: true }).first()).toBeVisible()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible()
    }
    const added = await (await request.get('/api/llm-connections')).json()
    expect(added.defaultSelection).toEqual(before.defaultSelection)
    expect(JSON.stringify(added)).not.toContain('sk-ant-e2e-placeholder')
    const first = added.connections.find((c: { name: string }) => c.name === 'First test account')
    const second = added.connections.find((c: { name: string }) => c.name === 'Second test account')
    await page.getByTestId('settings-model-trigger').first().click()
    await page.getByRole('combobox', { name: 'Connection' }).selectOption(first.id)
    await page.keyboard.press('Escape')
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/llm-connections')).json()).defaultSelection.connectionId
      )
      .toBe(first.id)
    expect((await request.delete(`/api/llm-connections/${first.id}`)).status()).toBe(400)
    await expect(
      page.getByRole('button', { name: 'Delete First test account', exact: true })
    ).toHaveCount(0)
    await page.getByTestId('settings-model-trigger').first().click()
    await page.getByRole('combobox', { name: 'Connection' }).selectOption(second.id)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Delete First test account', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Edit First test account', exact: true })
    ).toHaveCount(0)
    await page.goto('/')
    await expect(page.getByText('Click to set up')).toHaveCount(0)
  })
  test('switches an existing session to another account without changing the app default', async ({
    page,
    request,
  }) => {
    const baseline = await (await request.get('/api/llm-connections')).json()
    const accounts = []
    for (const name of ['Session account A', 'Session account B']) {
      const response = await request.post('/api/llm-connections', {
        data: {
          name,
          provider: 'anthropic',
          config: { apiKeys: { anthropicApiKey: 'sk-ant-e2e-placeholder' } },
        },
      })
      expect(response.status()).toBe(201)
      accounts.push((await response.json()).id)
    }
    const agent = await (
      await request.post('/api/agents', { data: { name: 'Connection switching test' } })
    ).json()
    const created = await request.post(`/api/agents/${agent.slug}/sessions`, {
      data: { message: 'Hello', model: 'sonnet', connectionId: accounts[0] },
    })
    expect(created.status()).toBe(201)
    const session = await created.json()
    const sessionPath = `/api/agents/${agent.slug}/sessions/${session.id}`
    await expect
      .poll(async () => (await (await request.get(sessionPath)).json()).isActive)
      .toBe(false)
    await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
    await page.getByTestId('composer-options-trigger').click()
    await expect(page.getByRole('combobox', { name: 'Connection' })).toHaveValue(accounts[0])
    await page.getByRole('combobox', { name: 'Connection' }).selectOption(accounts[1])
    await page.keyboard.press('Escape')
    await new SessionPage(page).sendMessage('Continue on the selected account.')
    await expect
      .poll(async () => (await (await request.get(sessionPath)).json()).connectionId)
      .toBe(accounts[1])
    expect((await (await request.get('/api/llm-connections')).json()).defaultSelection).toEqual(
      baseline.defaultSelection
    )
    await expect
      .poll(async () => (await (await request.get(sessionPath)).json()).isActive)
      .toBe(false)
    await page.reload()
    await page.getByTestId('composer-options-trigger').click()
    await expect(page.getByRole('combobox', { name: 'Connection' })).toHaveValue(accounts[1])
  })
})
