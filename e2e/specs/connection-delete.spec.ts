/**
 * Connection deletion cascade — the delete AlertDialog on the connection
 * detail page, driven for both connection types, with the cascade verified on
 * every surface: the detail view self-dismisses, the row disappears from the
 * originating list and the agent-home card, and the API confirms the global
 * record is gone while its dependents (agent mappings, scope/tool policies)
 * were FK-cascaded rather than orphaned. Every other spec deletes connections
 * only via API cleanup calls, so none of this UI path was previously driven.
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { createAgent, gotoAgentHome } from '../helpers/agents'
import {
  createRemoteMcp,
  assignRemoteMcpToAgent,
  expectAgentMissingRemoteMcp,
  listRemoteMcps,
} from '../helpers/connections'
import { startMockMcpServer, type MockMcpServer } from '../helpers/mock-mcp-server'

interface TestConnectedAccount {
  id: string
  toolkitSlug: string
  displayName: string
  status: string
}

interface PolicyRow {
  scope?: string
  toolName?: string
  decision: string
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

async function withMockMcp<T>(run: (mockMcp: MockMcpServer) => Promise<T>): Promise<T> {
  const mockMcp = await startMockMcpServer(0)
  try {
    return await run(mockMcp)
  } finally {
    await mockMcp.close()
  }
}

async function createConnectedAccount(
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
): Promise<TestConnectedAccount> {
  const suffix = uniqueSuffix(testInfo)
  const toolkitSlug = `e2e-${label}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const response = await request.post('/api/connected-accounts', {
    data: {
      providerConnectionId: `e2e-${toolkitSlug}`,
      providerName: 'e2e',
      toolkitSlug,
      displayName: `Delete Account ${suffix}`,
      status: 'active',
    },
  })

  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { account: TestConnectedAccount }
  expect(body.account.id).toBeTruthy()
  return body.account
}

async function assignAccountToAgent(
  request: APIRequestContext,
  agentSlug: string,
  accountId: string,
) {
  const response = await request.post(`/api/agents/${agentSlug}/connected-accounts`, {
    data: { accountIds: [accountId] },
  })
  expect(response.ok()).toBeTruthy()
}

async function getAgentConnectedAccountIds(
  request: APIRequestContext,
  agentSlug: string,
): Promise<string[]> {
  const response = await request.get(`/api/agents/${agentSlug}/connected-accounts`)
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { accounts: Array<{ id: string }> }
  return body.accounts.map((account) => account.id)
}

async function globalAccountIds(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/api/connected-accounts')
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { accounts: Array<{ id: string }> }
  return body.accounts.map((account) => account.id)
}

async function getScopePolicies(request: APIRequestContext, accountId: string): Promise<PolicyRow[]> {
  const response = await request.get(`/api/policies/scope/${accountId}`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { policies: PolicyRow[] }
  return body.policies
}

async function getToolPolicies(request: APIRequestContext, mcpId: string): Promise<PolicyRow[]> {
  const response = await request.get(`/api/policies/tool/${mcpId}`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { policies: PolicyRow[] }
  return body.policies
}

function detailRowButton(page: Page, name: string) {
  return page.getByRole('button', { name: `Open ${name} connection details`, exact: true })
}

/** Open the delete AlertDialog from the detail page and return its locator. */
async function openDeleteDialog(page: Page, type: 'oauth' | 'mcp', id: string) {
  await page.locator(`[data-testid="integration-row-actions-delete-${type}-${id}"]`).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('revokes access for every agent')
  return dialog
}

test.describe('Connection deletion cascade', () => {
  test('deleting an OAuth account cascades mappings and scope policies everywhere', async ({ page, request }, testInfo) => {
    const account = await createConnectedAccount(request, testInfo, 'del-acct')
    const agent = await createAgent(request, `Del Acct Agent ${uniqueSuffix(testInfo)}`)
    await assignAccountToAgent(request, agent.slug, account.id)

    // Saved scope policy so the FK cascade has something to cascade.
    const putRes = await request.put(`/api/policies/scope/${account.id}`, {
      data: { policies: [{ scope: '*', decision: 'allow' }] },
    })
    expect(putRes.ok()).toBeTruthy()
    expect(await getScopePolicies(request, account.id)).toHaveLength(1)

    try {
      // The agent-home card lists the mapped account before deletion.
      await gotoAgentHome(page, agent)
      await expect(page.getByText(account.displayName)).toBeVisible()

      await page.locator('[data-testid="home-connections-open-page"]').click()
      await expect(page.locator('[data-testid="connections-add-button"]')).toBeVisible()
      await detailRowButton(page, account.displayName).click()
      await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 10000 })

      // Cancel first: the dialog closes and nothing is deleted.
      let dialog = await openDeleteDialog(page, 'oauth', account.id)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).not.toBeVisible()
      expect(await globalAccountIds(request)).toContain(account.id)

      // Now delete for real.
      dialog = await openDeleteDialog(page, 'oauth', account.id)
      await expect(dialog).toContainText('Delete API connection?')
      await dialog.getByRole('button', { name: 'Delete' }).click()

      // The stale detail self-dismisses back to the connections list.
      await expect(page.locator('[data-testid="connections-add-button"]')).toBeVisible({ timeout: 10000 })
      await expect(page.locator('[data-testid="connection-detail-back"]')).toHaveCount(0)
      await expect(page.locator(`[data-testid="connection-switch-oauth-${account.id}"]`)).toHaveCount(0)

      // API: the account is gone, and its dependents cascaded rather than
      // being orphaned — the agent mapping and the scope policy rows.
      await expect.poll(
        async () => globalAccountIds(request),
        { timeout: 10000, message: `account ${account.id} still listed globally` },
      ).not.toContain(account.id)
      expect(await getAgentConnectedAccountIds(request, agent.slug)).toEqual([])
      expect(await getScopePolicies(request, account.id)).toEqual([])

      // The agent-home card no longer lists it.
      await gotoAgentHome(page, agent)
      await expect(page.getByText('No connections yet')).toBeVisible()
      await expect(page.getByText(account.displayName)).toHaveCount(0)
    } finally {
      await request.delete(`/api/connected-accounts/${account.id}`).catch(() => {})
    }
  })

  test('deleting an MCP server cascades mappings and tool policies, stale detail falls back', async ({ page, request }, testInfo) => {
    await withMockMcp(async (mockMcp) => {
      const mcpName = `Del MCP ${uniqueSuffix(testInfo)}`
      const mcp = await createRemoteMcp(request, { name: mcpName, url: mockMcp.url })
      const agent = await createAgent(request, `Del Mcp Agent ${uniqueSuffix(testInfo)}`)
      await assignRemoteMcpToAgent(request, agent.slug, mcp.id)

      // Saved tool policy so the FK cascade has something to cascade.
      const putRes = await request.put(`/api/policies/tool/${mcp.id}`, {
        data: { policies: [{ toolName: 'hello_world', decision: 'block' }] },
      })
      expect(putRes.ok()).toBeTruthy()
      expect(await getToolPolicies(request, mcp.id)).toHaveLength(1)

      try {
        // Drive this deletion from the global settings list — the other
        // detail-page surface (the account test drives the agent connections
        // page).
        await page.goto('/settings/connections')
        await expect(page.locator('[data-testid="default-policy-api"]')).toBeVisible({ timeout: 15000 })
        await detailRowButton(page, mcpName).click()
        await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 10000 })
        await expect(page).toHaveURL(new RegExp(`detail=mcp-${mcp.id}`))

        const dialog = await openDeleteDialog(page, 'mcp', mcp.id)
        await expect(dialog).toContainText('Delete MCP server?')
        await dialog.getByRole('button', { name: 'Delete' }).click()

        // The detail self-dismisses: the stale ?detail= is dropped from the
        // URL and the list renders again, without the deleted row.
        await expect(page.locator('[data-testid="default-policy-api"]')).toBeVisible({ timeout: 10000 })
        await expect(page).not.toHaveURL(/detail=/)
        await expect(detailRowButton(page, mcpName)).toHaveCount(0)

        // API: server gone, agent mapping gone, tool policies FK-cascaded.
        await expect.poll(
          async () => (await listRemoteMcps(request)).map((server) => server.id),
          { timeout: 10000, message: `MCP ${mcp.id} still listed globally` },
        ).not.toContain(mcp.id)
        await expectAgentMissingRemoteMcp(request, agent.slug, mcp.id)
        expect(await getToolPolicies(request, mcp.id)).toEqual([])

        // A stale deep-link to the deleted detail falls back to the list.
        await page.goto(`/settings/connections?detail=mcp-${mcp.id}`)
        await expect(page.locator('[data-testid="default-policy-api"]')).toBeVisible({ timeout: 15000 })
        await expect(page.locator('[data-testid="connection-detail-back"]')).toHaveCount(0)
        await expect(page).not.toHaveURL(/detail=/)
      } finally {
        await request.delete(`/api/remote-mcps/${mcp.id}`).catch(() => {})
      }
    })
  })
})
