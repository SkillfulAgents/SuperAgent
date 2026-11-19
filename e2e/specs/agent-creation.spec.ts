import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.beforeEach(async ({ page }) => {
  const app = new AppPage(page)
  await app.goto()
  await app.waitForAgentsLoaded()
})

test('refresh and Skip keep one named agent with no sessions', async ({ page, request }) => {
  const agentPage = new AgentPage(page)
  await agentPage.clickCreateAgent()
  const name = `Research ${Date.now()}`
  const created = page.waitForResponse(r => r.url().endsWith('/api/agents') && r.request().method() === 'POST' && r.status() === 201)
  await agentPage.nameNewAgent(name)
  const agent = await (await created).json()
  await expect(page.getByTestId('create-agent-skip')).toBeEnabled()
  await page.reload()
  await expect(page.getByTestId('agent-identity-name-label')).toHaveText(name)
  await page.getByTestId('create-agent-skip').click()
  await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
  const sessions = await request.get(`/api/agents/${agent.slug}/sessions`)
  expect(await sessions.json()).toEqual([])
  const agents = await (await request.get('/api/agents')).json()
  expect(agents.filter((other: { name: string }) => other.name === name)).toHaveLength(1)
})

test('refresh while the creation response is in flight resumes the same agent and job', async ({ page, request }) => {
  const agentPage = new AgentPage(page)
  await agentPage.clickCreateAgent()
  let held = false
  await page.route('**/api/agents', async route => {
    if (route.request().method() !== 'POST' || held) return route.continue()
    held = true
    // Let the server create the agent, but withhold the response from this document.
    await route.fetch()
  })
  const name = `Planner ${Date.now()}`
  await agentPage.nameNewAgent(name)
  const prompt = page.getByTestId('create-agent-prompt')
  await prompt.fill('Write a weekly brief')
  await expect(page.getByTestId('create-agent-skip')).toBeDisabled()
  const matches = async () => {
    const agents = await (await request.get('/api/agents')).json()
    return agents.filter((a: { name: string }) => a.name === name)
  }
  await expect.poll(async () => (await matches()).length).toBe(1)
  await page.reload()
  await expect(prompt).toHaveText('Write a weekly brief')
  await page.getByTestId('create-agent-skip').click()
  await expect(page.getByTestId('agent-breadcrumb')).toHaveText(name)
  expect(await matches()).toHaveLength(1)
})

test('a refreshed add-ons step sends the saved job to the same agent', async ({ page, request }) => {
  const agentPage = new AgentPage(page)
  await agentPage.clickCreateAgent()
  const created = page.waitForResponse(r => r.url().endsWith('/api/agents') && r.request().method() === 'POST' && r.status() === 201)
  await agentPage.nameNewAgent(`Planner ${Date.now()}`)
  const agent = await (await created).json()
  const job = 'Prepare a weekly research brief.'
  await page.getByTestId('create-agent-prompt').fill(job)
  await page.getByTestId('composer-options-trigger').click()
  await page.getByTestId('model-pinned-claude-sonnet-4-6').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('create-agent-continue').click()
  const memory = page.getByRole('switch', { name: 'Memories', exact: true })
  await expect(memory).toBeChecked()
  await memory.click()
  await expect(memory).not.toBeChecked()
  expect((await (await request.get(`/api/agents/${agent.slug}/preferences`)).json()).autoMemoryEnabled).toBe(false)
  await page.reload()
  await expect(page.getByTestId('agent-addons-step')).toBeVisible()
  await expect(memory).not.toBeChecked()
  const session = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(`/api/agents/${agent.slug}/sessions`))
  await page.getByTestId('create-agent-finish').click()
  expect((await session).postDataJSON()).toMatchObject({ model: 'claude-sonnet-4-6' })
  await expect(page).toHaveURL(new RegExp('/agents/' + agent.displaySlug + '/sessions/'))
  await expect(page.getByTestId('message-list')).toContainText(job)
})

async function reachAddons(page: Page) {
  const wizard = new AgentPage(page)
  await wizard.clickCreateAgent()
  const created = page.waitForResponse(r => r.url().endsWith('/api/agents') && r.request().method() === 'POST' && r.status() === 201)
  await wizard.nameNewAgent(`Setup review ${Date.now()}`)
  const agent = await (await created).json() as { slug: string }
  await page.getByTestId('create-agent-prompt').fill('Prepare a weekly research brief.')
  await page.getByTestId('create-agent-continue').click()
  await expect(page.getByTestId('agent-addons-step')).toBeVisible()
  return `/api/agents/${agent.slug}/sessions`
}

test('replaying Start session after a lost response opens the one accepted job', async ({ page, request }) => {
  const sessions = await reachAddons(page)
  let accepted: string | undefined
  await page.route('**' + sessions, async route => {
    if (route.request().method() !== 'POST' || accepted) return route.continue()
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    accepted = (await response.json()).id
    // Withhold the response to the original document.
  })
  await page.getByTestId('create-agent-finish').click()
  await expect.poll(() => accepted).toBeTruthy()
  await page.reload()
  await page.getByTestId('create-agent-finish').click()
  await expect(page).toHaveURL(new RegExp('/sessions/' + accepted + '$'))
  const list = await (await request.get(sessions)).json()
  expect(list.map((s: { id: string }) => s.id)).toEqual([accepted])
})

test('an unavailable skill catalog does not prevent starting the requested job', async ({ page }) => {
  await page.route('**/api/agents/*/skills', route => route.fulfill({ status: 503, json: { error: 'Inventory unavailable' } }))
  await page.route('**/api/agents/*/skills/refresh*', route => route.fulfill({ status: 503 }))
  await reachAddons(page)
  await page.getByTestId('create-agent-finish').click()
  await expect(page.getByTestId('message-list')).toContainText('Prepare a weekly research brief.')
})

test('Dream survives Skip and asks for its schedule only on the first job from Home', async ({ page, request }) => {
  const sessions = await reachAddons(page)
  const toggle = page.getByRole('switch', { name: 'Self-Improvement' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.getByTestId('new-agent-back').click()
  await page.getByTestId('create-agent-skip').click()
  await expect(page.getByTestId('home-message-input')).toBeVisible()
  expect(await (await request.get(sessions)).json()).toEqual([])
  await page.reload()
  await page.getByTestId('home-message-input').fill('My first real job')
  await page.getByTestId('home-send-button').click()
  await expect(page.getByTestId('message-list')).toContainText('Use the /dream skill to set up dreaming.')
  const second = await request.post(sessions, { data: { message: 'Another job' } })
  expect(second.status()).toBe(201)
  expect(await second.json()).not.toHaveProperty('initialMessage')
})

test('returning from templates restores the unconfirmed name, shape, and color', async ({ page }) => {
  await new AgentPage(page).clickCreateAgent()
  const name = page.getByTestId('agent-identity-name')
  await name.fill('Release coordinator')
  const shape = page.getByRole('button', { name: 'Diamond', exact: true })
  const color = page.getByRole('button', { name: 'Red', exact: true })
  await shape.click()
  await color.click()
  await page.getByRole('button', { name: 'Browse Templates' }).click()
  await page.reload()
  await page.getByTestId('new-agent-back').click()
  await expect(name).toHaveValue('Release coordinator')
  await expect(shape).toHaveAttribute('aria-pressed', 'true')
  await expect(color).toHaveAttribute('aria-pressed', 'true')
})

test('removing Dream before leaving the wizard clears its first-job instruction', async ({ page }) => {
  const sessions = await reachAddons(page)
  const toggle = page.getByRole('switch', { name: 'Self-Improvement' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  const started = page.waitForResponse(r => r.url().endsWith(sessions) && r.request().method() === 'POST')
  await page.getByTestId('create-agent-finish').click()
  const response = await started
  expect(response.status()).toBe(201)
  expect(await response.json()).not.toHaveProperty('initialMessage')
})

test('Finish setup completes the existing Slack webhook installation in the wizard', async ({ page }) => {
  let agentSlug = ''
  let connected = false
  const installation = () => ({
    id: 'pending-slack', agentSlug, name: 'Slack', provider: 'slack', status: connected ? 'active' : 'paused',
    connected, hasCredentials: connected,
    slack: {
      botTokenSaved: connected, signingSecretSaved: connected, appTokenSaved: false,
      webhook: { status: 'pending', url: 'https://example.invalid/hooks/test' },
    },
  })
  await page.route('**/api/agent-integrations/agents/*', route => {
    agentSlug = route.request().url().split('/').pop()!
    return route.fulfill({ json: [installation()] })
  })
  await page.route('**/api/agent-integrations/pending-slack', route => {
    if (route.request().method() === 'PATCH') connected = true
    return route.fulfill({ json: installation() })
  })
  await reachAddons(page)
  await page.getByRole('button', { name: 'Finish setup Slack' }).click()
  const dialog = page.getByRole('dialog', { name: 'Finish Slack setup' })
  await dialog.getByLabel('Signing Secret').fill('fixture-secret')
  await dialog.getByLabel('Bot Token').fill('fixture-token')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Configured Slack' })).toBeDisabled()
  await expect(page.getByTestId('create-agent-finish')).toBeEnabled()
})
