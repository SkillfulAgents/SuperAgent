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
          (await (await request.get('/api/llm-connections')).json()).defaultSelection.llmProviderId
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
      data: { message: 'Hello', model: 'sonnet', llmProviderId: accounts[0] },
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
      .poll(async () => (await (await request.get(sessionPath)).json()).llmProviderId)
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
  test('edits custom and disabled models without saving built-in catalog definitions', async ({ page, request }) => {
    const settings = await (await request.get('/api/settings/models')).json()
    const builtin = settings.llmProviderStatus.find((p: { id: string }) => p.id === 'anthropic').builtinCatalog[0]
    const custom = { id: 'private-catalog-model', label: 'Private model', supportedEfforts: ['low'], contextWindow: 100_000, disabled: true }
    const created = await request.post('/api/llm-connections', { data: {
      name: 'Catalog account', provider: 'anthropic', config: { apiKeys: { anthropicApiKey: 'test-key' } },
      modelOverrides: [{ id: builtin.id, disabled: true }, custom],
    } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    await page.goto('/settings/llm')
    await page.getByRole('button', { name: 'Edit Catalog account', exact: true }).click()
    await page.getByTestId('catalog-disclosure-trigger').click()
    await expect(page.getByTestId(`catalog-toggle-${builtin.id}`)).not.toBeChecked()
    await expect(page.getByTestId('catalog-toggle-private-catalog-model')).not.toBeChecked()
    await page.getByTestId('catalog-customize-private-catalog-model').click()
    await page.getByLabel('Display label').fill('Renamed private model')
    await page.getByTestId('catalog-save-custom-model').click()
    await page.getByTestId('catalog-toggle-private-catalog-model').click()
    const saved = page.waitForRequest(req => req.method() === 'PUT' && req.url().endsWith(`/llm-connections/${id}`))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const payload = (await saved).postDataJSON()
    expect(payload).not.toHaveProperty('catalog')
    expect(payload.modelOverrides).toEqual([
      { id: builtin.id, disabled: true },
      expect.objectContaining({ id: custom.id, label: 'Renamed private model', contextWindow: 100_000 }),
    ])
    expect(payload.modelOverrides[1].disabled).not.toBe(true)
    await expect(page.getByRole('heading', { name: 'Edit Catalog account' })).toHaveCount(0)
    await page.reload()
    await page.getByRole('button', { name: 'Edit Catalog account', exact: true }).click()
    await page.getByTestId('catalog-disclosure-trigger').click()
    await expect(page.getByTestId(`catalog-toggle-${builtin.id}`)).not.toBeChecked()
    await expect(page.getByTestId('catalog-toggle-private-catalog-model')).toBeChecked()
    await expect(page.getByTestId('model-catalog-editor').getByText('Renamed private model', { exact: true })).toBeVisible()
  })

  test('keeps custom variables scoped to a provider and supports masked edits and removal', async ({ page, request }) => {
    await addForm(page)
    await page.getByLabel('Name', { exact: true }).fill('Environment account')
    await page.getByLabel('API key', { exact: true }).fill('sk-ant-e2e-placeholder')
    await page.getByTestId('connection-env-editor').locator('summary').click()
    for (const [key, value] of [['ANTHROPIC_BASE_URL', 'https://custom-proxy.example'], ['PROVIDER_SECRET', 'private-value']]) {
      await page.getByLabel('Variable name', { exact: true }).fill(key)
      await page.getByLabel('Variable value', { exact: true }).fill(value)
      await page.getByRole('button', { name: 'Add variable', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Edit Environment account', exact: true }).click()
    await page.getByTestId('connection-env-editor').locator('summary').click()
    const saved = await (await request.get('/api/llm-connections')).json()
    const connection = saved.connections.find((row: { name: string }) => row.name === 'Environment account')
    expect(connection.customEnvVarKeys).toEqual(['ANTHROPIC_BASE_URL', 'PROVIDER_SECRET'])
    expect(JSON.stringify(saved)).not.toContain('private-value')
    await expect(page.getByLabel('Value for PROVIDER_SECRET', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Value for PROVIDER_SECRET', { exact: true })).toHaveAttribute('placeholder', 'Saved value (unchanged)')
    await page.getByLabel('Name', { exact: true }).fill('Renamed environment account')
    const unchanged = page.waitForRequest(req => req.method() === 'PUT' && req.url().endsWith(`/llm-connections/${connection.id}`))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await unchanged).postDataJSON().config.runtimeEnv).toEqual({})
    await page.getByRole('button', { name: 'Edit Renamed environment account', exact: true }).click()
    await page.getByTestId('connection-env-editor').locator('summary').click()
    await page.getByLabel('Value for PROVIDER_SECRET', { exact: true }).fill('replacement-value')
    await page.getByRole('button', { name: 'Remove ANTHROPIC_BASE_URL', exact: true }).click()
    const edited = page.waitForRequest(req => req.method() === 'PUT' && req.url().endsWith(`/llm-connections/${connection.id}`))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await edited).postDataJSON().config.runtimeEnv).toEqual({ PROVIDER_SECRET: 'replacement-value', ANTHROPIC_BASE_URL: null })
    await expect(page.getByTestId('llm-connection-editor')).toHaveCount(0)
    const after = await (await request.get('/api/llm-connections')).json()
    expect(after.connections.find((row: { id: string }) => row.id === connection.id).customEnvVarKeys).toEqual(['PROVIDER_SECRET'])
    expect(JSON.stringify(after)).not.toContain('replacement-value')
  })

  test('preserves custom endpoints on unrelated Generic and Bedrock edits', async ({ page, request }) => {
    for (const [provider, apiKeys, runtimeEnv] of [
      ['generic', { genericApiKey: 'test-key', genericBaseUrl: 'https://base.example' }, { ANTHROPIC_BASE_URL: 'https://custom.example' }],
      ['bedrock', { bedrockApiKey: 'test-key', bedrockRegion: 'us-east-1' }, { AWS_REGION: 'eu-west-1' }],
    ] as const) {
      const created = await request.post('/api/llm-connections', { data: { name: `${provider} custom env`, provider, config: { apiKeys, runtimeEnv } } })
      expect(created.status()).toBe(201)
      const { id } = await created.json()
      await page.goto('/settings/llm')
      await page.getByRole('button', { name: `Edit ${provider} custom env`, exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill(`${provider} renamed`)
      const saved = page.waitForRequest(req => req.method() === 'PUT' && req.url().endsWith(`/llm-connections/${id}`))
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      expect((await saved).postDataJSON().config.apiKeys).toEqual({})
      await expect(page.getByTestId('llm-connection-editor')).toHaveCount(0)
      const data = await (await request.get('/api/llm-connections')).json()
      expect(data.connections.find((row: { id: string }) => row.id === id).customEnvVarKeys).toEqual(Object.keys(runtimeEnv))
    }
  })

})
