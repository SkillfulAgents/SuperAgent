import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { createAgent, gotoAgentHome, type TestAgent } from '../helpers/agents'
import {
  createRemoteMcp,
  expectAgentHasRemoteMcp,
  expectRemoteMcpByUrl,
  findRemoteMcpByUrl,
  type TestRemoteMcp,
} from '../helpers/connections'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

const CONNECTED_ACCOUNT_REASON = 'Need access to your GitHub repositories'
const MCP_REASON = 'Need access to test tools'

interface TestConnectedAccount {
  id: string
  providerConnectionId: string
  providerName: string
  toolkitSlug: string
  displayName: string
  status: 'active' | 'revoked' | 'expired'
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

function uniqueSlug(testInfo: TestInfo, label: string) {
  return `${label}-${uniqueSuffix(testInfo)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
}

function messageParam(value: string) {
  return encodeURIComponent(value)
}

function connectedAccountRequestMessage(toolkit: string, reason = CONNECTED_ACCOUNT_REASON) {
  return [
    'ask account for access',
    `account_toolkit=${messageParam(toolkit)}`,
    `account_reason=${messageParam(reason)}`,
  ].join(' ')
}

function remoteMcpRequestMessage(mcpUrl: string, name: string, reason = MCP_REASON) {
  return [
    'request mcp server access',
    `mcp_url=${messageParam(mcpUrl)}`,
    `mcp_name=${messageParam(name)}`,
    `mcp_reason=${messageParam(reason)}`,
  ].join(' ')
}

async function withMockMcp<T>(run: (mockMcp: MockMcpServer) => Promise<T>): Promise<T> {
  const mockMcp = await startMockMcpServer(0)
  try {
    return await run(mockMcp)
  } finally {
    await mockMcp.close()
  }
}

async function createAndOpenAgent(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
): Promise<TestAgent> {
  const agent = await createAgent(request, uniqueName(testInfo, label))
  await gotoAgentHome(page, agent)
  return agent
}

async function openConnectedAccountRequest(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  options: { label: string; toolkit: string; reason?: string },
) {
  const agent = await createAndOpenAgent(page, request, testInfo, options.label)
  const sessionPage = new SessionPage(page)

  await sessionPage.sendMessage(connectedAccountRequestMessage(options.toolkit, options.reason))

  const requestCard = page.locator('[data-testid="connected-account-request"]')
  await expect(requestCard).toBeVisible({ timeout: 15000 })

  return {
    agent,
    requestCard,
    sessionPage,
    agentPage: new AgentPage(page),
  }
}

async function openRemoteMcpRequest(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  options: { label: string; mcpUrl: string; mcpName: string; reason?: string },
) {
  const agent = await createAndOpenAgent(page, request, testInfo, options.label)
  const sessionPage = new SessionPage(page)

  await sessionPage.sendMessage(remoteMcpRequestMessage(options.mcpUrl, options.mcpName, options.reason))

  const requestCard = page.locator('[data-testid="remote-mcp-request"]')
  await expect(requestCard).toBeVisible({ timeout: 15000 })

  return {
    agent,
    requestCard,
    sessionPage,
    agentPage: new AgentPage(page),
  }
}

async function createConnectedAccount(
  request: APIRequestContext,
  data: { toolkitSlug: string; displayName: string },
): Promise<TestConnectedAccount> {
  const response = await request.post('/api/connected-accounts', {
    data: {
      providerConnectionId: `e2e-${data.toolkitSlug}`,
      providerName: 'e2e',
      toolkitSlug: data.toolkitSlug,
      displayName: data.displayName,
      status: 'active',
    },
  })

  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { account: TestConnectedAccount }
  expect(body.account.id).toBeTruthy()
  expect(body.account.toolkitSlug).toBe(data.toolkitSlug)
  expect(body.account.displayName).toBe(data.displayName)
  expect(body.account.status).toBe('active')

  return body.account
}

async function deleteConnectedAccount(request: APIRequestContext, accountId: string) {
  await request.delete(`/api/connected-accounts/${accountId}`).catch(() => {})
}

async function deleteRemoteMcp(request: APIRequestContext, mcpId: string) {
  await request.delete(`/api/remote-mcps/${mcpId}`).catch(() => {})
}

async function getAgentConnectedAccountIds(request: APIRequestContext, agentSlug: string): Promise<string[]> {
  const response = await request.get(`/api/agents/${agentSlug}/connected-accounts`)
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { accounts: Array<{ id: string }> }
  return body.accounts.map((account) => account.id)
}

async function expectAgentHasConnectedAccount(
  request: APIRequestContext,
  agentSlug: string,
  accountId: string,
) {
  await expect.poll(
    async () => getAgentConnectedAccountIds(request, agentSlug),
    { timeout: 10000, message: `agent ${agentSlug} never received account ${accountId}` },
  ).toContain(accountId)
}

async function expectAgentHasNoConnectedAccounts(request: APIRequestContext, agentSlug: string) {
  await expect.poll(
    async () => getAgentConnectedAccountIds(request, agentSlug),
    { timeout: 10000, message: `agent ${agentSlug} unexpectedly has connected accounts` },
  ).toEqual([])
}

test.describe('Connected Accounts - Agent Request Flow', () => {
  test('agent request shows connected account UI with service label and reason', async ({ page, request }, testInfo) => {
    const toolkit = uniqueSlug(testInfo, 'e2e-account-service')
    const { requestCard } = await openConnectedAccountRequest(page, request, testInfo, {
      label: 'Account Agent',
      toolkit,
    })

    await expect(requestCard).toContainText(CONNECTED_ACCOUNT_REASON)
    await expect(requestCard).toContainText(new RegExp(toolkit, 'i'))
    await expect(requestCard.getByRole('button', { name: /Deny/i })).toBeVisible()
  })

  test('connected account request shows Connect button when no matching accounts exist', async ({ page, request }, testInfo) => {
    const toolkit = uniqueSlug(testInfo, 'e2e-account-empty')
    const { requestCard } = await openConnectedAccountRequest(page, request, testInfo, {
      label: 'Account Connect',
      toolkit,
    })

    await expect(requestCard.getByRole('button', { name: /^Connect$/i })).toBeVisible()
    await expect(requestCard.getByRole('button', { name: /Allow Access/i })).toHaveCount(0)
    await expect(requestCard.getByRole('button', { name: /Deny/i })).toBeVisible()
  })

  test('connected account request grants an existing account and maps it to the agent', async ({ page, request }, testInfo) => {
    const toolkit = uniqueSlug(testInfo, 'e2e-account-grant')
    const displayName = uniqueName(testInfo, 'Grant Account')
    const account = await createConnectedAccount(request, { toolkitSlug: toolkit, displayName })

    try {
      const { agent, requestCard, sessionPage, agentPage } = await openConnectedAccountRequest(page, request, testInfo, {
        label: 'Account Grant',
        toolkit,
      })

      const accountOption = requestCard.getByRole('button', { name: new RegExp(displayName) })
      await expect(accountOption).toBeVisible({ timeout: 10000 })
      await expect(accountOption.locator('input[type="checkbox"]')).toBeChecked()

      const grantBtn = requestCard.getByRole('button', { name: /Allow Access/i })
      await expect(grantBtn).toBeEnabled()
      await grantBtn.click()

      await sessionPage.waitForInputEnabled(15000)
      await agentPage.waitForStatus('idle', 10000)
      await expectAgentHasConnectedAccount(request, agent.slug, account.id)
    } finally {
      await deleteConnectedAccount(request, account.id)
    }
  })

  test('declining connected account request completes the session without mapping accounts', async ({ page, request }, testInfo) => {
    const toolkit = uniqueSlug(testInfo, 'e2e-account-decline')
    const { agent, requestCard, sessionPage, agentPage } = await openConnectedAccountRequest(page, request, testInfo, {
      label: 'Account Decline',
      toolkit,
    })

    const declineBtn = requestCard.getByRole('button', { name: /Deny/i })
    await expect(declineBtn).toBeVisible()
    await declineBtn.click()

    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 10000)
    await expectAgentHasNoConnectedAccounts(request, agent.slug)
  })

  test('agent shows awaiting_input status during connected account request', async ({ page, request }, testInfo) => {
    const toolkit = uniqueSlug(testInfo, 'e2e-account-status')
    const { requestCard, sessionPage, agentPage } = await openConnectedAccountRequest(page, request, testInfo, {
      label: 'Account Status',
      toolkit,
    })

    await agentPage.waitForStatus('awaiting_input', 10000)

    await requestCard.getByRole('button', { name: /Deny/i }).click()
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 10000)
  })

  test('tool call for request_connected_account renders with service info', async ({ page, request }, testInfo) => {
    const toolkit = uniqueSlug(testInfo, 'e2e-account-tool')
    const { requestCard, sessionPage } = await openConnectedAccountRequest(page, request, testInfo, {
      label: 'Account Tool',
      toolkit,
    })

    await sessionPage.expectToolCall('mcp__user-input__request_connected_account', 15000)

    const toolCall = sessionPage.getToolCall('mcp__user-input__request_connected_account')
    await expect(toolCall).toBeVisible()
    await expect(toolCall).toContainText('Waiting for input')
    await expect(requestCard).toContainText(new RegExp(toolkit, 'i'))
  })
})

test.describe('Remote MCP - Full Connection Flow', () => {
  test('agent MCP request shows request card with server details', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const mcpName = uniqueName(testInfo, 'Request MCP')
      const mcpUrl = mockMcp.url
      const { requestCard } = await openRemoteMcpRequest(page, request, testInfo, {
        label: 'MCP Agent',
        mcpUrl,
        mcpName,
      })

      await expect(requestCard).toContainText(mcpName)
      await expect(requestCard).toContainText(mcpUrl)
      await expect(requestCard).toContainText(MCP_REASON)
      await expect(requestCard.getByRole('button', { name: /^Connect$/i })).toBeVisible()

      const persisted = await findRemoteMcpByUrl(request, mcpUrl, mcpName)
      expect(persisted, 'viewing a request should not register the MCP server').toBeUndefined()
    })
  })

  test('register MCP server and grant access - full flow', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const mcpName = uniqueName(testInfo, 'Full Flow MCP')
      const mcpUrl = mockMcp.url
      let created: TestRemoteMcp | undefined

      try {
        const { agent, requestCard, sessionPage, agentPage } = await openRemoteMcpRequest(page, request, testInfo, {
          label: 'MCP Full',
          mcpUrl,
          mcpName,
        })

        const connectBtn = requestCard.getByRole('button', { name: /^Connect$/i })
        await expect(connectBtn).toBeVisible()
        await connectBtn.click()

        created = await expectRemoteMcpByUrl(request, mcpUrl, mcpName)
        expect(created.status).toBe('active')
        expect(created.authType).toBe('none')
        expect(created.tools.map((tool) => tool.name).sort()).toEqual(['get_weather', 'hello_world'])

        await expect(requestCard.getByText(mcpName)).toBeVisible({ timeout: 10000 })

        const grantBtn = requestCard.getByRole('button', { name: /Allow Access/i })
        await expect(grantBtn).toBeEnabled()
        await grantBtn.click()

        await sessionPage.waitForInputEnabled(15000)
        await agentPage.waitForStatus('idle', 10000)
        await expectAgentHasRemoteMcp(request, agent.slug, created.id)
      } finally {
        if (created) await deleteRemoteMcp(request, created.id)
      }
    })
  })

  test('decline MCP request completes the session without registering a server', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const mcpName = uniqueName(testInfo, 'Decline MCP')
      const mcpUrl = mockMcp.url
      const { requestCard, sessionPage, agentPage } = await openRemoteMcpRequest(page, request, testInfo, {
        label: 'MCP Decline',
        mcpUrl,
        mcpName,
      })

      const declineBtn = requestCard.getByRole('button', { name: /Deny/i })
      await expect(declineBtn).toBeVisible()
      await declineBtn.click()

      await sessionPage.waitForInputEnabled(15000)
      await agentPage.waitForStatus('idle', 10000)

      const persisted = await findRemoteMcpByUrl(request, mcpUrl, mcpName)
      expect(persisted, 'declining should not register the MCP server').toBeUndefined()
    })
  })

  test('previously registered MCP server appears in selection list', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const mcpName = uniqueName(testInfo, 'Existing MCP')
      const mcpUrl = mockMcp.url
      const mcp = await createRemoteMcp(request, { name: mcpName, url: mcpUrl })

      try {
        const { agent, requestCard, sessionPage, agentPage } = await openRemoteMcpRequest(page, request, testInfo, {
          label: 'MCP Existing',
          mcpUrl,
          mcpName,
        })

        await expect(requestCard.getByText(mcpName)).toBeVisible({ timeout: 10000 })
        await expect(requestCard).toContainText(mcpUrl)

        const grantBtn = requestCard.getByRole('button', { name: /Allow Access/i })
        await expect(grantBtn).toBeEnabled()
        await grantBtn.click()

        await sessionPage.waitForInputEnabled(15000)
        await agentPage.waitForStatus('idle', 10000)
        await expectAgentHasRemoteMcp(request, agent.slug, mcp.id)
      } finally {
        await deleteRemoteMcp(request, mcp.id)
      }
    })
  })
})
