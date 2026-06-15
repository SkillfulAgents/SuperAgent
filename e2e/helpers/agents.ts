import { expect, type APIRequestContext, type Page } from '@playwright/test'

export interface TestAgent {
  slug: string
  name: string
}

async function expectAgentInApi(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug' | 'name'>,
) {
  await expect.poll(async () => {
    const response = await request.get('/api/agents')
    if (!response.ok()) return false

    const agents = await response.json() as TestAgent[]
    return agents.some((candidate) => (
      candidate.slug === agent.slug && candidate.name === agent.name
    ))
  }, { timeout: 15000 }).toBe(true)
}

function getAgentItem(page: Page, agent: Pick<TestAgent, 'slug' | 'name'>) {
  return page
    .locator(`[data-testid="agent-item-${agent.slug}"]`)
    .or(page.locator('[data-testid^="agent-item-"]', { hasText: agent.name }))
    .first()
}

export async function createAgent(request: APIRequestContext, name: string): Promise<TestAgent> {
  const response = await request.post('/api/agents', {
    data: { name },
  })

  expect(response.ok()).toBeTruthy()
  const agent = await response.json() as TestAgent
  expect(agent.slug).toBeTruthy()
  expect(agent.name).toBe(name)
  await expectAgentInApi(request, agent)

  return agent
}

export async function openAgentHome(page: Page, agent: Pick<TestAgent, 'slug' | 'name'>) {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const agentItem = getAgentItem(page, agent)

    try {
      await expect(agentItem).toBeVisible({ timeout: 10000 })
      await agentItem.scrollIntoViewIfNeeded({ timeout: 10000 })
      await agentItem.click()

      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
      return
    } catch (error) {
      lastError = error
      if (attempt === 1) break

      await page.reload()
      await expect(page.locator('[data-testid="new-agent-button"]')).toBeVisible({ timeout: 15000 })
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not open agent "${agent.name}" (${agent.slug})`)
}
