/**
 * Navigation invariants - exercises the discriminated-union AgentView model
 * (SUP-161). Verifies that switching between every kind of agent view leaves
 * exactly one view active and that durable routes restore from the URL.
 *
 * Keep at least one test for each user-facing navigation flow as a real UI
 * click path. API setup is used only to create independent, deterministic
 * state for route/durability cases where creation itself is not under test.
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent as createAgentViaApi,
  createSession,
  gotoAgentHome,
  openAgentSession,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

interface TestConnectedAccount {
  id: string
  name: string
}

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

function collectPageErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function createNavAgent(
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
) {
  return createAgentViaApi(request, uniqueName(testInfo, label))
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

function cleanupAgents(_request: APIRequestContext, _agents: Array<TestAgent | undefined>) {
  // Intentionally defer cleanup to the next setup-e2e-data run. This spec runs
  // fully parallel against a file-backed agent store; deleting agents mid-run
  // can race sibling tests that are listing agents and scanning session files.
}

async function expectGlobalHome(page: Page) {
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('[data-testid="home-button"]')).toHaveAttribute('data-active', 'true')
  await expect(page.locator('[data-testid="agent-breadcrumb"]')).not.toBeVisible()
}

async function expectAgentHome(page: Page, agent?: Pick<TestAgent, 'name'>) {
  if (agent) {
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
  } else {
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible({ timeout: 15000 })
  }
  await expect(page).toHaveURL(/\/agents\/[^/]+$/)
  await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="message-list"]')).not.toBeVisible()
}

async function expectSessionView(page: Page, session?: Pick<TestSession, 'id'>) {
  if (session) {
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}$`))
  } else {
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/)
  }
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible({ timeout: 15000 })
}

test.describe('Navigation - discriminated AgentView', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let connectionAccount: TestConnectedAccount

  test.beforeAll(async ({ request }) => {
    // Each worker gets an account, because fullyParallel runs beforeAll per
    // worker. The account list is global, but tests target their worker's id.
    const unique = [
      process.pid,
      Date.now(),
      Math.random().toString(36).slice(2, 8),
    ].join('-')
    const displayName = `E2E Nav Detail ${unique}`
    const res = await request.post('/api/connected-accounts', {
      data: {
        providerConnectionId: `e2e-nav-conn-detail-${unique}`,
        toolkitSlug: 'slack',
        displayName,
      },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    connectionAccount = { id: body.account.id as string, name: displayName }
  })

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
  })

  async function loadApp() {
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  }

  test('UI: create/select agent and global Home route stay in sync', async ({ page, request }, testInfo) => {
    const agentName = uniqueName(testInfo, 'Nav Home')
    let createdAgent: TestAgent | undefined

    try {
      await loadApp()

      // Real UI creation is intentionally covered once in this spec. The rest
      // of the suite can API-seed agents without losing create/select coverage.
      await agentPage.createAgent(agentName)
      createdAgent = await findAgentByName(request, agentName)
      await expectAgentHome(page, createdAgent)
      await expect(agentPage.getAgentItem(agentName)).toBeVisible()

      await page.locator('[data-testid="home-button"]').click()
      await expectGlobalHome(page)

      // Sidebar agent selection is also a real UI navigation flow.
      await agentPage.selectAgent(agentName)
      await expectAgentHome(page, createdAgent)

      await page.locator('[data-testid="home-button"]').click()
      await expectGlobalHome(page)
    } finally {
      await cleanupAgents(request, [createdAgent])
    }
  })

  test('UI: Agent -> API Logs -> back returns to agent home', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav API Logs')

    try {
      await gotoAgentHome(page, agent)

      await page.getByTestId('home-api-logs-open-page').click()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

      await page.locator('[data-testid="api-logs-back-button"]').click()
      await expectAgentHome(page, agent)
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: Agent -> Connections -> detail row -> back returns through list to home', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Connections')

    try {
      await gotoAgentHome(page, agent)

      await page.locator('[data-testid="home-connections-open-page"]').click()
      await expect(page).toHaveURL(/\/connections$/)
      await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()

      const row = page.getByRole('button', {
        name: `Open ${connectionAccount.name} connection details`,
      })
      await expect(row).toBeVisible({ timeout: 15000 })
      await row.click()

      await expect(page).toHaveURL(new RegExp(`detail=account-${connectionAccount.id}`))
      await expect(page).toHaveURL(/source=list/)
      await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 15000 })
      await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()

      await page.locator('[data-testid="connection-detail-back"]').click()
      await expect(page).toHaveURL(/\/connections$/)
      await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="connection-detail-back"]')).not.toBeVisible()

      await page.locator('[data-testid="connections-back-button"]').click()
      await expectAgentHome(page, agent)
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: API Logs -> Connections -> API Logs leaves only one sub-view active', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Mutex')

    try {
      await gotoAgentHome(page, agent)

      await page.getByTestId('home-api-logs-open-page').click()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

      await page.locator('[data-testid="api-logs-back-button"]').click()
      await page.locator('[data-testid="home-connections-open-page"]').click()
      await expect(page).toHaveURL(/\/connections$/)
      await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="api-logs-back-button"]')).not.toBeVisible()

      await page.locator('[data-testid="connections-back-button"]').click()
      await page.getByTestId('home-api-logs-open-page').click()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: browser back/forward walks agent sub-view transitions with the URL', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav BackFwd')

    try {
      await gotoAgentHome(page, agent)

      await page.getByTestId('home-api-logs-open-page').click()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

      // In-app back pushes an agent-home entry before the next leaf route.
      await page.locator('[data-testid="api-logs-back-button"]').click()
      await expectAgentHome(page, agent)

      await page.locator('[data-testid="home-connections-open-page"]').click()
      await expect(page).toHaveURL(/\/connections$/)
      await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="api-logs-back-button"]')).not.toBeVisible()

      await page.goBack()
      await expectAgentHome(page, agent)

      await page.goBack()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()

      await page.goBack()
      await expectAgentHome(page, agent)

      await page.goForward()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()

      await page.goForward()
      await expectAgentHome(page, agent)

      await page.goForward()
      await expect(page).toHaveURL(/\/connections$/)
      await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="api-logs-back-button"]')).not.toBeVisible()

      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: switching agents resets the selected agent to home', async ({ page, request }, testInfo) => {
    const agentA = await createNavAgent(request, testInfo, 'Nav Switch A')
    const agentB = await createNavAgent(request, testInfo, 'Nav Switch B')

    try {
      await loadApp()

      await agentPage.selectAgent(agentB.name)
      await expectAgentHome(page, agentB)
      await page.getByTestId('home-api-logs-open-page').click()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

      await agentPage.selectAgent(agentA.name)
      await expectAgentHome(page, agentA)
      await expect(page.locator('[data-testid="api-logs-back-button"]')).not.toBeVisible()
    } finally {
      await cleanupAgents(request, [agentA, agentB])
    }
  })

  test('UI: session breadcrumb returns to agent home', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Crumb')
    const session = await createSession(request, agent, 'breadcrumb route')

    try {
      await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
      await expectSessionView(page, session)

      await page.locator('[data-testid="agent-breadcrumb"]').click()
      await expectAgentHome(page, agent)
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Session URL route survives a hard reload', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Session Reload')
    const session = await createSession(request, agent, 'hello session route')

    try {
      await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
      await expectSessionView(page, session)

      await appPage.reload()
      await expectSessionView(page, session)
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Cold reload restores the Selection-driven session sub-crumb', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Crumb Restore')
    const session = await createSession(request, agent, 'restore my crumb')

    try {
      await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
      await expectSessionView(page, session)
      await expect(page.locator('[data-testid="session-breadcrumb"]')).toBeVisible({ timeout: 15000 })

      await appPage.reload()
      await expectSessionView(page, session)
      await expect(page.locator('[data-testid="session-breadcrumb"]')).toBeVisible({ timeout: 15000 })
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: session survives a sibling round-trip with the agent shell mounted', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav Session Survive')
    const session = await createSession(request, agent, 'survive me')

    try {
      await loadApp()
      await openAgentSession(page, agent, session)
      await sessionPage.expectUserMessage('survive me')

      await page.locator('[data-testid="agent-breadcrumb"]').click()
      await expectAgentHome(page, agent)

      await agentPage.expandAgent(agent.name)
      await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agent.name))
      await expectSessionView(page, session)
      await sessionPage.expectUserMessage('survive me')
      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('API Logs deep-link survives reload', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav API Logs Reload')

    try {
      await page.goto(`/agents/${agent.slug}/api-logs`)
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()

      await appPage.reload()
      await expect(page).toHaveURL(/\/api-logs$/)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(page.locator('[data-testid="api-logs-back-button"]')).toBeVisible()
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Dashboard leaf route resolves on a cold deep-link without crashing', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav Dash')

    try {
      await page.goto(`/agents/${agent.slug}/dashboards/sample-dashboard`)
      await expect(page).toHaveURL(/\/dashboards\/sample-dashboard$/)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Chat leaf route resolves on a cold deep-link with ?session= search', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav Chat')

    try {
      await page.goto(`/agents/${agent.slug}/chat/sample-integration?session=sample-session`)
      await expect(page).toHaveURL(/\/chat\/sample-integration\?session=sample-session$/)
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Sidebar highlights the agent on a cold reload', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Sidebar Active')

    try {
      await page.goto(`/agents/${agent.slug}`)
      await appPage.reload()
      await expectAgentHome(page, agent)
      await expect(page.locator('[data-testid^="agent-item-"]', { hasText: agent.name })).toHaveAttribute('data-active', 'true')
      await expect(page.locator('[data-testid="home-button"]')).toHaveAttribute('data-active', 'false')
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: Notifications route lights up only the Notifications nav item', async ({ page, request }, testInfo) => {
    const agent = await createNavAgent(request, testInfo, 'Nav Notif Active')

    try {
      await loadApp()

      await page.locator('[data-testid="notifications-button"]').click()
      await expect(page).toHaveURL(/\/notifications$/)
      await expect(page.locator('[data-testid="notifications-button"]')).toHaveAttribute('data-active', 'true')
      await expect(page.locator('[data-testid="home-button"]')).toHaveAttribute('data-active', 'false')
      await expect(page.locator('[data-testid^="agent-item-"]', { hasText: agent.name })).toHaveAttribute('data-active', 'false')
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('UI: Notifications route survives reload and Back leaves it', async ({ page }) => {
    await loadApp()

    await page.locator('[data-testid="notifications-button"]').click()
    await expect(page).toHaveURL(/\/notifications$/)
    await expect(page.locator('[data-testid="notifications-back-button"]')).toBeVisible()

    await appPage.reload()
    await expect(page).toHaveURL(/\/notifications$/)
    await expect(page.locator('[data-testid="notifications-back-button"]')).toBeVisible()

    await page.locator('[data-testid="notifications-back-button"]').click()
    await expect(page).not.toHaveURL(/\/notifications/)
  })

  test('Deep-linking an unknown agent shows the ambiguous not-found screen', async ({ page }) => {
    const errors = collectPageErrors(page)

    await page.goto('/agents/does-not-exist-r15')
    await expect(page).toHaveURL(/\/agents\/does-not-exist-r15$/)
    await expect(page.locator('[data-testid="agent-not-found"]')).toBeVisible()
    await expect(page.locator('[data-testid="home-button"]')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('Home is a durable route and reload stays on global home', async ({ page }) => {
    await loadApp()
    await appPage.reload()
    await expectGlobalHome(page)
  })

  test('Deep-linking a non-existent session shows the not-found leaf', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav Session Not Found')

    try {
      await page.goto(`/agents/${agent.slug}/sessions/does-not-exist-r17`)
      await expect(page.locator('[data-testid="session-not-found"]')).toBeVisible({ timeout: 15000 })
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Connections detail overlay is deep-linkable and reload-durable; source=list back returns to the list', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav Conn Detail')

    try {
      await page.goto(`/agents/${agent.slug}/connections?detail=account-${connectionAccount.id}&source=list`)
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/connections\\?`))
      await expect(page).toHaveURL(new RegExp(`detail=account-${connectionAccount.id}`))
      await expect(page).toHaveURL(/source=list/)
      await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 15000 })
      await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()

      await appPage.reload()
      await expect(page).toHaveURL(new RegExp(`detail=account-${connectionAccount.id}`))
      await expect(page).toHaveURL(/source=list/)
      await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 15000 })
      await expect(page.locator('[data-testid="connections-back-button"]')).not.toBeVisible()

      await page.locator('[data-testid="connection-detail-back"]').click()
      await expect(page).toHaveURL(/\/connections$/)
      await expect(page.locator('[data-testid="connections-back-button"]')).toBeVisible()
      await expect(page.locator('[data-testid="connection-detail-back"]')).not.toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })

  test('Connections detail overlay with source=home: Back returns to agent home', async ({ page, request }, testInfo) => {
    const errors = collectPageErrors(page)
    const agent = await createNavAgent(request, testInfo, 'Nav Conn Detail Home')

    try {
      await page.goto(`/agents/${agent.slug}/connections?detail=account-${connectionAccount.id}&source=home`)
      await expect(page).toHaveURL(new RegExp(`detail=account-${connectionAccount.id}`))
      await expect(page).toHaveURL(/source=home/)
      await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 15000 })

      await page.locator('[data-testid="connection-detail-back"]').click()
      await expectAgentHome(page, agent)
      await expect(page.locator('[data-testid="connection-detail-back"]')).not.toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await cleanupAgents(request, [agent])
    }
  })
})
