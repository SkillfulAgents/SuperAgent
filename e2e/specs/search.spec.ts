/**
 * Search palette - Cmd-K combo box that filters agents and sessions.
 *
 * Keep the primary search/navigation path as a real UI-created flow. API setup
 * is used for supporting cases once creation itself is covered, so the spec can
 * run fully parallel without shared ordering assumptions except for the
 * intentionally bounded recent-agent coverage.
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import {
  createAgent as createAgentViaApi,
  createSession,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

function uniqueSuffix(testInfo: TestInfo) {
  return [
    testInfo.workerIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
    Date.now(),
    Math.random().toString(36).slice(2, 8),
  ].join('-')
}

function uniqueName(testInfo: TestInfo, label: string) {
  return `${label} ${uniqueSuffix(testInfo)}`
}

function searchInput(page: Page) {
  return page.locator('[data-testid="search-input"]')
}

function searchResults(page: Page) {
  return page.locator('[data-testid="search-results"]')
}

function searchAgentRow(page: Page, agent: Pick<TestAgent, 'slug'>) {
  return searchResults(page).locator(
    `[data-testid="search-agent-row"][data-agent-slug="${agent.slug}"]`,
  )
}

function searchSessionRow(
  page: Page,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
) {
  return searchResults(page).locator(
    `[data-testid="search-session-row"][data-agent-slug="${agent.slug}"][data-session-id="${session.id}"]`,
  )
}

async function openSearchWithKeyboard(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(searchInput(page)).toBeVisible()
  await expect(searchInput(page)).toBeFocused()
  await expect(searchResults(page)).toBeVisible()
}

async function openSearchWithSidebarButton(page: Page) {
  await page.locator('[data-testid="search-button"]').click()
  await expect(searchInput(page)).toBeVisible()
  await expect(searchInput(page)).toBeFocused()
  await expect(searchResults(page)).toBeVisible()
}

async function findAgentByName(
  request: APIRequestContext,
  name: string,
): Promise<TestAgent> {
  let found: TestAgent | undefined

  await expect.poll(async () => {
    const response = await request.get('/api/agents')
    if (!response.ok()) return false

    const agents = await response.json() as TestAgent[]
    found = agents.find((agent) => agent.name === name)
    return Boolean(found)
  }, { timeout: 15000 }).toBe(true)

  return found!
}

async function getFirstSession(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
): Promise<TestSession> {
  let found: TestSession | undefined

  await expect.poll(async () => {
    const response = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!response.ok()) return false

    const sessions = await response.json() as TestSession[]
    found = sessions[0]
    return Boolean(found?.id)
  }, { timeout: 15000 }).toBe(true)

  return found!
}

async function renameSession(
  request: APIRequestContext,
  agent: Pick<TestAgent, 'slug'>,
  session: Pick<TestSession, 'id'>,
  name: string,
): Promise<TestSession> {
  let renamed: TestSession | undefined

  await expect.poll(async () => {
    const patchResponse = await request.patch(
      `/api/agents/${agent.slug}/sessions/${session.id}`,
      { data: { name } },
    )
    if (!patchResponse.ok()) return false

    const sessionsResponse = await request.get(`/api/agents/${agent.slug}/sessions`)
    if (!sessionsResponse.ok()) return false

    const sessions = await sessionsResponse.json() as TestSession[]
    renamed = sessions.find((candidate) => candidate.id === session.id)
    return renamed?.name === name
  }, { timeout: 15000 }).toBe(true)

  return renamed!
}

async function createSearchData(
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
) {
  const suffix = uniqueSuffix(testInfo)
  const agent = await createAgentViaApi(request, `Search ${label} Agent ${suffix}`)
  const setupSession = await createSession(request, agent, `search ${label} setup ${suffix}`)
  const session = await renameSession(
    request,
    agent,
    setupSession,
    `Search ${label} Session ${suffix}`,
  )

  return { agent, session, suffix }
}

async function expectSessionRoute(
  page: Page,
  agent: Pick<TestAgent, 'slug' | 'name'>,
  session: Pick<TestSession, 'id'>,
) {
  await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/sessions/${session.id}$`))
  await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
}

// Search reads global agent/session indexes. These tests leave their unique
// data in the per-run data dir instead of deleting it mid-run, because deletes
// can race sibling workers that are listing those file-backed indexes.
test.describe('Search palette', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('UI: Cmd-K filters by session name and Enter navigates into the session', async ({ page, request }, testInfo) => {
    const suffix = uniqueSuffix(testInfo)
    const agentName = `Search UI Agent ${suffix}`
    const sessionName = `Refactor Login Session ${suffix}`

    await agentPage.createAgent(agentName, { waitForSidebarName: false })
    const createdAgent = await findAgentByName(request, agentName)
    const setupSession = await getFirstSession(request, createdAgent)
    const session = await renameSession(request, createdAgent, setupSession, sessionName)

    // React Query may still hold the pre-rename session; reload so the search
    // palette fetches the deterministic name on open.
    await appPage.reload()

    await openSearchWithKeyboard(page)
    await searchInput(page).fill(`refactor login session ${suffix}`)

    await expect(searchAgentRow(page, createdAgent)).toBeVisible()
    await expect(searchSessionRow(page, createdAgent, session)).toBeVisible()

    // The query matches only the session. The grouped result keeps the agent
    // at index 0 and the matching session at index 1.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(searchInput(page)).not.toBeVisible()
    await expectSessionRoute(page, createdAgent, session)
  })

  test('API: Cmd-K session navigation pushes a reload-durable URL route', async ({ page, request }, testInfo) => {
    const { agent, session, suffix } = await createSearchData(request, testInfo, 'Durable')

    await appPage.reload()
    await openSearchWithKeyboard(page)
    await searchInput(page).fill(`durable session ${suffix}`)

    await expect(searchAgentRow(page, agent)).toBeVisible()
    await expect(searchSessionRow(page, agent, session)).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expectSessionRoute(page, agent, session)

    await appPage.reload()
    await expectSessionRoute(page, agent, session)
  })

  test('UI: sidebar Search button opens the dialog and Escape closes it', async ({ page }) => {
    await openSearchWithSidebarButton(page)

    await page.keyboard.press('Escape')
    await expect(searchInput(page)).not.toBeVisible()
  })

  test('API: filtering by agent name and Enter opens agent home', async ({ page, request }, testInfo) => {
    const agent = await createAgentViaApi(request, uniqueName(testInfo, 'Search Direct Agent'))

    await appPage.reload()
    await openSearchWithKeyboard(page)
    await searchInput(page).fill(agent.name.toLowerCase())

    await expect(searchAgentRow(page, agent)).toBeVisible()
    await expect(searchAgentRow(page, agent)).toHaveAttribute('data-agent-name', agent.name)
    await page.keyboard.press('Enter')

    await expect(searchInput(page)).not.toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}$`))
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible({ timeout: 15000 })
  })

  test('API: empty query recent agent expands, collapses, and opens a targeted session', async ({ page, request }, testInfo) => {
    const { agent, session } = await createSearchData(request, testInfo, 'Recent')

    await appPage.reload()
    await openSearchWithKeyboard(page)

    const agentRow = searchAgentRow(page, agent)
    const sessionRow = searchSessionRow(page, agent, session)

    // Empty-query search intentionally exercises the top-10 recent-agent list.
    // With workers=4, only a few sibling agents can become newer than this one;
    // revisit this if main-suite parallelism approaches that recent-list width.
    await expect(agentRow).toBeVisible({ timeout: 15000 })

    const expand = agentRow.getByTestId('search-agent-expand')
    await expect(expand).toBeVisible({ timeout: 15000 })
    await expect(sessionRow).not.toBeVisible()

    await agentRow.hover()
    await page.keyboard.press('ArrowRight')
    await expect(sessionRow).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await expect(sessionRow).not.toBeVisible()

    await expand.click()
    await expect(sessionRow).toBeVisible()

    await sessionRow.hover()
    await page.keyboard.press('Enter')
    await expect(searchInput(page)).not.toBeVisible()
    await expectSessionRoute(page, agent, session)
  })

  test('API: unmatched query shows an empty state without stale rows', async ({ page }, testInfo) => {
    const query = `no-search-results-${uniqueSuffix(testInfo)}`

    await openSearchWithKeyboard(page)
    await searchInput(page).fill(query)

    await expect(searchResults(page).getByText('No matches found')).toBeVisible()
    await expect(searchResults(page).getByTestId('search-agent-row')).toHaveCount(0)
    await expect(searchResults(page).getByTestId('search-session-row')).toHaveCount(0)
  })
})
