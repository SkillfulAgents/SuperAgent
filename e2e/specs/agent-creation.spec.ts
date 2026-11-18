import { test, expect } from '@playwright/test'
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
