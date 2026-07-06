import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'

export interface TestAgent {
  slug: string
  name: string
}

export interface TestSession {
  id: string
  name: string
}

export interface TestMessage {
  type: string
  content?: unknown
}

export interface TestPendingProxyReview {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  displayText?: string
  xAgent?: {
    targetAgentSlug: string
    targetAgentName: string
    operation: 'list' | 'read' | 'invoke' | 'create'
    preview?: string
  }
}

export function uniqueSuffix(
  testInfo: Pick<TestInfo, 'workerIndex' | 'repeatEachIndex' | 'retry'>,
) {
  return [
    testInfo.workerIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
    Date.now(),
    Math.random().toString(36).slice(2, 8),
  ].join('-')
}

export function uniqueName(
  testInfo: Pick<TestInfo, 'workerIndex' | 'repeatEachIndex' | 'retry'>,
  label: string,
) {
  return `${label} ${uniqueSuffix(testInfo)}`
}

async function retryablePollRead<T>(
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

async function expectAgentInApi(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug' | 'name'>,
) {
  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get('/api/agents')
    if (!response.ok()) return false

    const agents = await response.json() as TestAgent[]
    return agents.some((candidate) => (
      candidate.slug === agent.slug && candidate.name === agent.name
    ))
  }, false), { timeout: 15000 }).toBe(true)
}

export function getAgentItem(page: Page, agent: Pick<TestAgent, 'slug' | 'name'>) {
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

export async function findAgentByName(
  request: APIRequestContext,
  name: string,
): Promise<TestAgent> {
  let found: TestAgent | undefined

  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get('/api/agents')
    if (!response.ok()) return false

    const agents = await response.json() as TestAgent[]
    found = agents.find((agent) => agent.name === name)
    return Boolean(found)
  }, false), { timeout: 15000 }).toBe(true)

  return found!
}

export async function waitForCurrentSessionId(page: Page): Promise<Pick<TestSession, 'id'>> {
  let sessionId: string | undefined

  await expect.poll(() => {
    try {
      const match = new URL(page.url()).pathname.match(/\/sessions\/([^/]+)/)
      sessionId = match?.[1]
    } catch {
      sessionId = undefined
    }
    return Boolean(sessionId)
  }, { timeout: 15000 }).toBe(true)

  return { id: sessionId! }
}

export async function expectAgentNamed(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  name: string,
): Promise<TestAgent> {
  let found: TestAgent | undefined

  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get('/api/agents')
    if (!response.ok()) return undefined

    const agents = await response.json() as TestAgent[]
    found = agents.find((candidate) => candidate.slug === agent.slug)
    return found?.name
  }, undefined as string | undefined), { timeout: 15000 }).toBe(name)

  return found!
}

export async function waitForPendingProxyReview(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  options: {
    xAgent?: boolean
    toolkit?: string
    targetPath?: string
    matchedScope?: string
  } = {},
): Promise<TestPendingProxyReview> {
  let found: TestPendingProxyReview | undefined

  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get(`/api/agents/${agent.slug}/proxy-reviews`)
    if (!response.ok()) return false

    const body = await response.json() as { reviews?: TestPendingProxyReview[] }
    found = (body.reviews ?? []).find((review) => {
      if (options.xAgent !== undefined && Boolean(review.xAgent) !== options.xAgent) return false
      if (options.toolkit && review.toolkit !== options.toolkit) return false
      if (options.targetPath && review.targetPath !== options.targetPath) return false
      if (options.matchedScope && !review.matchedScopes.includes(options.matchedScope)) return false
      return true
    })

    return Boolean(found)
  }, false), { timeout: 15000 }).toBe(true)

  return found!
}

export async function expectPendingProxyReviewResolved(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  review: Pick<TestPendingProxyReview, 'id'>,
) {
  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get(`/api/agents/${agent.slug}/proxy-reviews`)
    if (!response.ok()) return false

    const body = await response.json() as { reviews?: TestPendingProxyReview[] }
    return !(body.reviews ?? []).some((candidate) => candidate.id === review.id)
  }, false), { timeout: 15000 }).toBe(true)
}

export async function deleteAgentViaApi(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
) {
  const response = await request.delete(`/api/agents/${agent.slug}`)
  expect([204, 404]).toContain(response.status())
}

export async function expectAgentDeleted(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
) {
  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get('/api/agents')
    if (!response.ok()) return false

    const agents = await response.json() as TestAgent[]
    return !agents.some((candidate) => candidate.slug === agent.slug)
  }, false), { timeout: 15000 }).toBe(true)
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

  await expect.poll(() => retryablePollRead(async () => {
    const sessionsResponse = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!sessionsResponse.ok()) return false

    const sessions = await sessionsResponse.json() as TestSession[]
    return sessions.some((candidate) => candidate.id === session.id)
  }, false), { timeout: 15000 }).toBe(true)

  return session
}

export async function listSessions(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
): Promise<TestSession[]> {
  const response = await request.get(`/api/agents/${agent.slug}/sessions`)
  expect(response.ok()).toBeTruthy()

  return await response.json() as TestSession[]
}

export async function renameSessionViaApi(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
  name: string,
) {
  const response = await request.patch(`/api/agents/${agent.slug}/sessions/${session.id}`, {
    data: { name },
  })
  expect(response.ok()).toBeTruthy()
}

export async function expectSessionNamed(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
  name: string,
): Promise<TestSession> {
  let found: TestSession | undefined

  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!response.ok()) return undefined

    const sessions = await response.json() as TestSession[]
    found = sessions.find((candidate) => candidate.id === session.id)
    return found?.name
  }, undefined as string | undefined), { timeout: 15000 }).toBe(name)

  return found!
}

export async function listSessionMessages(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
): Promise<TestMessage[]> {
  const response = await request.get(`/api/agents/${agent.slug}/sessions/${session.id}/messages`)
  expect(response.ok()).toBeTruthy()

  return await response.json() as TestMessage[]
}

export function messageContentIncludes(message: TestMessage, text: string) {
  if (typeof message.content === 'string') {
    return message.content.includes(text)
  }

  if (!message.content || typeof message.content !== 'object') {
    return false
  }

  const content = message.content as Record<string, unknown>
  return typeof content.text === 'string' && content.text.includes(text)
}

export async function findSessionWithUserMessage(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  text: string,
): Promise<TestSession> {
  let found: TestSession | undefined

  await expect.poll(() => retryablePollRead(async () => {
    const sessionsResponse = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!sessionsResponse.ok()) return false

    const sessions = await sessionsResponse.json() as TestSession[]
    for (const session of sessions) {
      const messagesResponse = await request.get(`/api/agents/${agent.slug}/sessions/${session.id}/messages`)
      if (!messagesResponse.ok()) continue

      const messages = await messagesResponse.json() as TestMessage[]
      if (messages.some((message) => message.type === 'user' && messageContentIncludes(message, text))) {
        found = session
        return true
      }
    }

    return false
  }, false), { timeout: 15000 }).toBe(true)

  return found!
}

export async function waitForSessionIdle(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
) {
  await expect.poll(() => retryablePollRead(async () => {
    const response = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!response.ok()) return false

    const sessions = await response.json() as Array<TestSession & { isActive?: boolean }>
    const current = sessions.find((candidate) => candidate.id === session.id)
    return current ? current.isActive === false : false
  }, false), { timeout: 15000 }).toBe(true)
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

export async function gotoAgentSession(
  page: Page,
  agent: Pick<TestAgent, 'slug' | 'name'>,
  session: Pick<TestSession, 'id'>,
) {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
      await expect(page.locator('[data-testid="message-input"]')).toBeVisible({ timeout: 15000 })
      return
    } catch (error) {
      lastError = error
      if (attempt === 1) break

      await page.reload()
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load session "${session.id}" for agent "${agent.name}" (${agent.slug})`)
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
