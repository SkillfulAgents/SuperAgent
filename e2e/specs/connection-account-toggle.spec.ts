/**
 * Agent access to OAuth connected accounts — grant and revoke through the two
 * real surfaces: the per-agent connections page row toggle and the connection
 * detail page's sectioned Agents column. Both drive the same agent<->account
 * mapping endpoints behind an optimistic UI override, so every flip is
 * verified against the API mapping (the DB is the source of truth once the
 * override clears), and revoking must never delete the global account.
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { createAgent, openAgentHome, type TestAgent } from '../helpers/agents'

interface TestConnectedAccount {
  id: string
  toolkitSlug: string
  displayName: string
  status: string
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

async function createConnectedAccount(
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
): Promise<TestConnectedAccount> {
  const suffix = uniqueSuffix(testInfo)
  // Unique toolkit per test: accounts are global, so a shared slug would leak
  // rows into other workers' account-selection surfaces.
  const toolkitSlug = `e2e-${label}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const response = await request.post('/api/connected-accounts', {
    data: {
      providerConnectionId: `e2e-${toolkitSlug}`,
      providerName: 'e2e',
      toolkitSlug,
      displayName: `Toggle Account ${suffix}`,
      status: 'active',
    },
  })

  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { account: TestConnectedAccount }
  expect(body.account.id).toBeTruthy()
  return body.account
}

async function deleteConnectedAccount(request: APIRequestContext, accountId: string) {
  await request.delete(`/api/connected-accounts/${accountId}`).catch(() => {})
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

async function expectAgentMissingConnectedAccount(
  request: APIRequestContext,
  agentSlug: string,
  accountId: string,
) {
  await expect.poll(
    async () => getAgentConnectedAccountIds(request, agentSlug),
    { timeout: 10000, message: `agent ${agentSlug} still has account ${accountId}` },
  ).not.toContain(accountId)
}

async function getAccountAgentSlugs(
  request: APIRequestContext,
  accountId: string,
): Promise<string[]> {
  const response = await request.get(`/api/connected-accounts/${accountId}/agents`)
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { agentSlugs: string[] }
  return [...body.agentSlugs].sort()
}

async function expectAccountAgents(
  request: APIRequestContext,
  accountId: string,
  expectedSlugs: string[],
) {
  await expect.poll(
    async () => getAccountAgentSlugs(request, accountId),
    { timeout: 10000, message: `account ${accountId} agents never became [${expectedSlugs.join(', ')}]` },
  ).toEqual([...expectedSlugs].sort())
}

async function expectGlobalAccountPresent(request: APIRequestContext, accountId: string) {
  const response = await request.get('/api/connected-accounts')
  expect(response.ok()).toBeTruthy()

  const body = await response.json() as { accounts: Array<{ id: string }> }
  expect(
    body.accounts.some((account) => account.id === accountId),
    'revoking agent access must not delete the global account',
  ).toBe(true)
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
  await expectAgentHasConnectedAccount(request, agentSlug, accountId)
}

async function openAgentConnectionsPage(page: Page, agent: Pick<TestAgent, 'slug' | 'name'>) {
  const appPage = new AppPage(page)
  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentHome(page, agent)
  await page.locator('[data-testid="home-connections-open-page"]').click()
  await expect(page.locator('[data-testid="connections-add-button"]')).toBeVisible()
}

function rowSwitch(page: Page, accountId: string) {
  return page.locator(`[data-testid="connection-switch-oauth-${accountId}"]`)
}

function agentToggle(page: Page, accountId: string, agentSlug: string) {
  return page.locator(`[data-testid="connection-agent-toggle-oauth-${accountId}-${agentSlug}"]`)
}

test.describe('Agent access to connected accounts', () => {
  test('row toggle grants an OAuth account to the agent', async ({ page, request }, testInfo) => {
    const account = await createConnectedAccount(request, testInfo, 'acct-grant')

    try {
      const agent = await createAgent(request, `Acct Toggle On ${uniqueSuffix(testInfo)}`)
      await openAgentConnectionsPage(page, agent)

      const switchLocator = rowSwitch(page, account.id)
      await expect(switchLocator).toBeVisible({ timeout: 10000 })
      await expect(switchLocator).toHaveAttribute('data-state', 'unchecked')
      expect(await getAgentConnectedAccountIds(request, agent.slug)).toEqual([])

      await switchLocator.click()

      // The toggle is optimistic + async — wait for the API mapping (the local
      // override clears once the server catches up, so the DB is the truth).
      await expectAgentHasConnectedAccount(request, agent.slug, account.id)
      await expect(switchLocator).toHaveAttribute('data-state', 'checked')

      // The row lands in the "Access granted" section.
      const grantedSection = page.locator('div:has(> p:text-is("Access granted"))')
      await expect(grantedSection).toContainText(account.displayName)
    } finally {
      await deleteConnectedAccount(request, account.id)
    }
  })

  test('row toggle off revokes the mapping but keeps the global account', async ({ page, request }, testInfo) => {
    const account = await createConnectedAccount(request, testInfo, 'acct-revoke')

    try {
      const agent = await createAgent(request, `Acct Toggle Off ${uniqueSuffix(testInfo)}`)
      await assignAccountToAgent(request, agent.slug, account.id)
      await openAgentConnectionsPage(page, agent)

      const switchLocator = rowSwitch(page, account.id)
      await expect(switchLocator).toBeVisible({ timeout: 10000 })
      await expect(switchLocator).toHaveAttribute('data-state', 'checked', { timeout: 10000 })

      await switchLocator.click()

      await expectAgentMissingConnectedAccount(request, agent.slug, account.id)
      await expect(switchLocator).toHaveAttribute('data-state', 'unchecked')
      // With no grants left, the granted section shows its empty state.
      await expect(page.getByText("can't access any connections yet")).toBeVisible()

      await expectGlobalAccountPresent(request, account.id)
    } finally {
      await deleteConnectedAccount(request, account.id)
    }
  })

  test('detail-page Agents column grants a second agent and revokes both', async ({ page, request }, testInfo) => {
    const account = await createConnectedAccount(request, testInfo, 'acct-detail')

    try {
      const agentA = await createAgent(request, `Acct Detail A ${uniqueSuffix(testInfo)}`)
      const agentB = await createAgent(request, `Acct Detail B ${uniqueSuffix(testInfo)}`)
      await assignAccountToAgent(request, agentA.slug, account.id)

      await openAgentConnectionsPage(page, agentA)

      // Click the connection row itself to open the detail page.
      await page
        .getByRole('button', { name: `Open ${account.displayName} connection details`, exact: true })
        .click()
      await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible({ timeout: 10000 })

      const toggleA = agentToggle(page, account.id, agentA.slug)
      const toggleB = agentToggle(page, account.id, agentB.slug)
      await expect(toggleA).toHaveAttribute('data-state', 'checked', { timeout: 10000 })
      await expect(toggleB).toHaveAttribute('data-state', 'unchecked', { timeout: 10000 })

      // The sectioned column starts with A under "Agents With Access".
      const withAccessSection = page.locator('div:has(> p:text-is("Agents With Access"))')
      await expect(withAccessSection).toContainText(agentA.name)

      // Grant the second agent from the "Agents Without Access" section.
      await toggleB.click()
      await expectAccountAgents(request, account.id, [agentA.slug, agentB.slug])
      await expect(toggleB).toHaveAttribute('data-state', 'checked')
      await expect(withAccessSection).toContainText(agentB.name)

      // Revoke both. Each toggle swaps to a spinner while its mutation is in
      // flight, so gate on the API mapping between clicks.
      await toggleA.click()
      await expectAccountAgents(request, account.id, [agentB.slug])
      await expect(toggleA).toHaveAttribute('data-state', 'unchecked')

      await toggleB.click()
      await expectAccountAgents(request, account.id, [])
      await expect(page.getByText('No agents have access yet. Grant one below.')).toBeVisible()

      // Revoking every agent must not touch the account itself.
      await expectGlobalAccountPresent(request, account.id)
    } finally {
      await deleteConnectedAccount(request, account.id)
    }
  })

  test('failed grant snaps the row toggle back and persists nothing', async ({ page, request }, testInfo) => {
    const account = await createConnectedAccount(request, testInfo, 'acct-fail')

    try {
      const agent = await createAgent(request, `Acct Toggle Fail ${uniqueSuffix(testInfo)}`)
      await openAgentConnectionsPage(page, agent)

      let sawAssignPost = false
      await page.route(`**/api/agents/${agent.slug}/connected-accounts`, async (route) => {
        // Only fail the assignment POST — the page's list queries share this
        // URL shape as GETs.
        if (route.request().method() !== 'POST') return route.fallback()
        sawAssignPost = true
        // Fulfill instantly: a fast failure is the regression vector for the
        // revert racing the view-transition-deferred optimistic set.
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Injected assignment failure' }),
        })
      })

      const switchLocator = rowSwitch(page, account.id)
      await expect(switchLocator).toBeVisible({ timeout: 10000 })
      await switchLocator.click()

      // Prove the click actually drove the POST into the failing route, then
      // assert the optimistic flip reverted and nothing persisted.
      await expect.poll(() => sawAssignPost, { timeout: 10000 }).toBe(true)
      await expect(switchLocator).toHaveAttribute('data-state', 'unchecked', { timeout: 10000 })
      expect(await getAgentConnectedAccountIds(request, agent.slug)).toEqual([])
    } finally {
      await deleteConnectedAccount(request, account.id)
    }
  })

  test('failed grant on the detail page snaps the agent toggle back', async ({ page, request }, testInfo) => {
    const account = await createConnectedAccount(request, testInfo, 'acct-detail-fail')

    try {
      const agentA = await createAgent(request, `Acct Detail Fail A ${uniqueSuffix(testInfo)}`)
      const agentB = await createAgent(request, `Acct Detail Fail B ${uniqueSuffix(testInfo)}`)
      await assignAccountToAgent(request, agentA.slug, account.id)

      await openAgentConnectionsPage(page, agentA)
      await page
        .getByRole('button', { name: `Open ${account.displayName} connection details`, exact: true })
        .click()

      const toggleB = agentToggle(page, account.id, agentB.slug)
      await expect(toggleB).toHaveAttribute('data-state', 'unchecked', { timeout: 10000 })

      let sawAssignPost = false
      await page.route(`**/api/agents/${agentB.slug}/connected-accounts`, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        sawAssignPost = true
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Injected assignment failure' }),
        })
      })

      await toggleB.click()

      // The sectioned column must snap the agent back to "Without Access" and
      // the mapping must stay exactly as it was.
      await expect.poll(() => sawAssignPost, { timeout: 10000 }).toBe(true)
      await expect(toggleB).toHaveAttribute('data-state', 'unchecked', { timeout: 10000 })
      await expectAccountAgents(request, account.id, [agentA.slug])
    } finally {
      await deleteConnectedAccount(request, account.id)
    }
  })
})
