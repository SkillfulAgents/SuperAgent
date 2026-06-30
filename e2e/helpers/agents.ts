import { expect, type APIRequestContext, type Page } from '@playwright/test'

export interface TestAgent {
  slug: string
  name: string
}

export interface TestSession {
  id: string
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

export async function createSession(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  message: string,
): Promise<TestSession> {
  const response = await request.post(`/api/agents/${agent.slug}/sessions`, {
    data: { message },
  })

  expect(response.ok()).toBeTruthy()
  const session = await response.json() as TestSession
  expect(session.id).toBeTruthy()
  expect(session.name).toBeTruthy()

  await expect.poll(async () => {
    const sessionsResponse = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!sessionsResponse.ok()) return false

    const sessions = await sessionsResponse.json() as TestSession[]
    return sessions.some((candidate) => candidate.id === session.id)
  }, { timeout: 15000 }).toBe(true)

  return session
}

export async function waitForSessionIdle(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
) {
  await expect.poll(async () => {
    const response = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!response.ok()) return false

    const sessions = await response.json() as Array<TestSession & { isActive?: boolean }>
    const current = sessions.find((candidate) => candidate.id === session.id)
    return current ? current.isActive === false : false
  }, { timeout: 15000 }).toBe(true)
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

export async function gotoAgentHome(page: Page, agent: Pick<TestAgent, 'slug' | 'name'>) {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(`/agents/${agent.slug}`)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible({ timeout: 15000 })
      return
    } catch (error) {
      lastError = error
      if (attempt === 1) break

      await page.reload()
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load agent "${agent.name}" (${agent.slug})`)
}

export async function openAgentSession(
  page: Page,
  agent: Pick<TestAgent, 'slug' | 'name'>,
  session: Pick<TestSession, 'id'>,
) {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const agentItem = getAgentItem(page, agent)

    try {
      await expect(agentItem).toBeVisible({ timeout: 10000 })
      await agentItem.scrollIntoViewIfNeeded({ timeout: 10000 })

      const agentLi = agentItem.locator('xpath=ancestor::li[1]')
      const expandChevron = agentLi.locator('button[aria-label="Expand"]').first()
      if (await expandChevron.isVisible({ timeout: 500 }).catch(() => false)) {
        await expandChevron.click()
      }

      const sessionItem = page.locator(`[data-testid="session-item-${session.id}"]`)
      await expect(sessionItem).toBeVisible({ timeout: 15000 })
      await sessionItem.scrollIntoViewIfNeeded({ timeout: 10000 })
      await sessionItem.click()

      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
      await expect(page.locator('[data-testid="message-input"]')).toBeVisible({ timeout: 15000 })
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
    : new Error(`Could not open session "${session.id}" for agent "${agent.name}" (${agent.slug})`)
}
