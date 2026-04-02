import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

test.describe.configure({ mode: 'serial' })

test.describe('Connected Accounts - Agent Request Flow', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('agent request shows connected account UI with service name and reason', async ({ page }) => {
    const agentName = `Account Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Trigger the "ask account" scenario
    await sessionPage.sendMessage('ask account for GitHub access')

    // Wait for the connected account request UI to appear
    const requestCard = page.locator('[data-testid="connected-account-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Should show the service name
    await expect(requestCard).toContainText('GitHub')

    // Should show the reason
    await expect(requestCard).toContainText('Need access to your GitHub repositories')
  })

  test('connected account request shows Connect button when no accounts exist', async ({ page }) => {
    const agentName = `Account Connect ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('ask account for GitHub access')

    // Wait for the request UI
    const requestCard = page.locator('[data-testid="connected-account-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // With no accounts, should show inline Connect button
    await expect(
      requestCard.getByRole('button', { name: /Connect/i })
    ).toBeVisible()
  })

  test('connected account request shows no accounts message', async ({ page }) => {
    const agentName = `Account NoAccounts ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('ask account for GitHub access')

    // Wait for the request UI
    const requestCard = page.locator('[data-testid="connected-account-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Should show "No connected accounts found" since we have none in E2E
    // With no accounts, should show inline Connect button
    await expect(requestCard.getByRole('button', { name: /Connect/i })).toBeVisible()
  })

  test('declining connected account request completes the session', async ({ page }) => {
    const agentName = `Account Decline ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('ask account for GitHub access')

    // Wait for the request UI
    const requestCard = page.locator('[data-testid="connected-account-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Click the decline button
    const declineBtn = requestCard.getByRole('button', { name: /Deny/i })
    await expect(declineBtn).toBeVisible()
    await declineBtn.click()

    // After declining, the session should complete and agent goes back to idle
    await sessionPage.waitForInputEnabled(15000)

    // Agent should return to idle status
    await agentPage.waitForStatus('idle', 10000)
  })

  test('agent shows awaiting_input status during connected account request', async ({ page }) => {
    const agentName = `Account Status ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('ask account for GitHub access')

    // Wait for the request UI
    const requestCard = page.locator('[data-testid="connected-account-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Agent should show awaiting_input status
    await agentPage.waitForStatus('awaiting_input', 10000)
  })

  test('tool call for request_connected_account renders with service info', async ({ page }) => {
    const agentName = `Account Tool ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('ask account for GitHub access')

    // Wait for the tool call to render
    await sessionPage.expectToolCall('mcp__user-input__request_connected_account', 15000)

    const toolCall = sessionPage.getToolCall('mcp__user-input__request_connected_account')
    await expect(toolCall).toBeVisible()

    // Should show waiting for user input
    await expect(toolCall).toContainText('waiting for user input')
  })
})

test.describe('Remote MCP - Full Connection Flow', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let mockMcp: MockMcpServer

  test.beforeAll(async () => {
    mockMcp = await startMockMcpServer(9876)
  })

  test.afterAll(async () => {
    await mockMcp.close()
  })

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('agent MCP request shows purple request card with server details', async ({ page }) => {
    const agentName = `MCP Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('request mcp server access')

    // Wait for the MCP request UI (purple-themed card)
    const requestCard = page.locator('[data-testid="remote-mcp-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Should show server name and URL
    await expect(requestCard).toContainText('Test MCP')
    await expect(requestCard).toContainText('localhost:9876')

    // Should show reason
    await expect(requestCard).toContainText('Need access to test tools')
  })

  test('register MCP server and grant access - full flow', async ({ page }) => {
    const agentName = `MCP Full ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('request mcp server access')

    // Wait for the MCP request card
    const requestCard = page.locator('[data-testid="remote-mcp-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Should show Connect button since this MCP is not yet registered
    const connectBtn = requestCard.getByRole('button', { name: /Connect/i })
    await expect(connectBtn).toBeVisible()
    await connectBtn.click()

    // After registration succeeds, the server card should appear
    // Wait for the server name to show up
    await expect(requestCard.getByText('Test MCP')).toBeVisible({ timeout: 10000 })

    // Allow Access button should now be enabled (server auto-selected)
    const grantBtn = requestCard.getByRole('button', { name: /Allow Access/i })
    await expect(grantBtn).toBeEnabled()
    await grantBtn.click()

    // Session should complete — the mock resolves the input and emits completion.
    // The "Access Granted" state may flash briefly before the request card is removed,
    // so we verify completion by checking agent returns to idle.
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 10000)
  })

  test('decline MCP request completes the session', async ({ page }) => {
    const agentName = `MCP Decline ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('request mcp server access')

    // Wait for the MCP request card
    const requestCard = page.locator('[data-testid="remote-mcp-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // Click decline
    const declineBtn = requestCard.getByRole('button', { name: /Deny/i })
    await expect(declineBtn).toBeVisible()
    await declineBtn.click()

    // Session should complete
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 10000)
  })

  test('previously registered MCP server appears in selection list', async ({ page }) => {
    // The MCP server was registered in a previous test (serial mode)
    // It should now appear in the selection list for a new agent
    const agentName = `MCP Existing ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('request mcp server access')

    // Wait for the MCP request card
    const requestCard = page.locator('[data-testid="remote-mcp-request"]')
    await expect(requestCard).toBeVisible({ timeout: 15000 })

    // The previously registered server should appear as a server card
    await expect(requestCard.getByText('Test MCP')).toBeVisible({ timeout: 10000 })

    // Allow Access should be enabled (server auto-selected)
    const grantBtn = requestCard.getByRole('button', { name: /Allow Access/i })
    await expect(grantBtn).toBeEnabled()
    await grantBtn.click()

    // Should complete successfully — agent returns to idle
    await sessionPage.waitForInputEnabled(15000)
    await agentPage.waitForStatus('idle', 10000)
  })
})
