import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

const API = ''

test.describe('Connections Page — Policy Modal After OAuth', () => {
  let appPage: AppPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  /**
   * Simulates an OAuth flow completing from the global Connections page.
   *
   * The session-view flow (ConnectedAccountRequestItem) automatically opens
   * the ScopePolicyEditor after a new account is connected. The connections
   * page should do the same — this test verifies that behavior.
   */
  test('connecting an API from the connections page opens the scope policy editor', async ({ page, request }) => {
    // 1. Open Settings → Connections
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-connections"]').click()

    // 2. Open the "Add New Connection" directory dialog (APIs tab is default).
    //    Scope to .first(): the empty-state CTA also carries this test id, so
    //    when no connections exist the bare locator matches two elements.
    const addButton = page.locator('[data-testid="connections-add-button"]').first()
    await expect(addButton).toBeVisible()
    await addButton.click()

    const dialog = page.getByRole('dialog', { name: 'Add New Connection' })
    await expect(dialog).toBeVisible()

    // 2b. Initiate a connection so the OAuth callback listener is active — it
    //     only registers while a connect flow is in flight (SUP-265). /initiate
    //     hits Composio, which isn't reachable under E2E_MOCK, so stub it.
    await page.route('**/api/connected-accounts/initiate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connectionId: 'e2e-pending-conn',
          redirectUrl: 'about:blank',
          providerSlug: 'slack',
          providerName: 'composio',
        }),
      })
    })
    await page.getByTestId('directory-connect-api-slack').click()

    // 3. Create an account server-side (simulates what the OAuth callback
    //    endpoint does when Composio returns a successful connection)
    const providerConnectionId = `e2e-policy-modal-${Date.now()}`
    const res = await request.post(`${API}/api/connected-accounts`, {
      data: {
        providerConnectionId,
        toolkitSlug: 'slack',
        displayName: 'E2E Policy Modal Slack',
      },
    })
    expect(res.ok()).toBeTruthy()
    const { account } = await res.json()

    // 4. Simulate the postMessage that the OAuth popup sends back to the
    //    opener window after a successful connection.
    await page.evaluate(
      ({ accountId }) => {
        window.postMessage(
          { type: 'oauth-callback', success: true, accountId, toolkitSlug: 'slack' },
          window.location.origin,
        )
      },
      { accountId: account.id },
    )

    // 5. The integration directory dialog should close
    await expect(dialog).toBeHidden({ timeout: 5000 })

    // 6. The ScopePolicyEditor should automatically open for the new account.
    //    This is the behavior the session-view flow already has, and the
    //    connections page should match it.
    const scopeEditor = page.getByText('Successfully Connected!')
    await expect(scopeEditor).toBeVisible({ timeout: 5000 })
  })

  test('connecting an API from the agent connections page opens the scope policy editor', async ({ page, request }) => {
    const agentPage = new AgentPage(page)
    const agentName = `Policy Modal Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Navigate to the agent's connections page
    await page.locator('[data-testid="home-connections-open-page"]').click()
    await expect(page.locator('[data-testid="connections-add-button"]')).toBeVisible()

    // Open the "Add New Connection" dialog
    await page.locator('[data-testid="connections-add-button"]').click()
    const dialog = page.getByRole('dialog', { name: 'Add New Connection' })
    await expect(dialog).toBeVisible()

    // Initiate a connection so the OAuth callback listener is active (SUP-265).
    await page.route('**/api/connected-accounts/initiate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connectionId: 'e2e-pending-conn',
          redirectUrl: 'about:blank',
          providerSlug: 'slack',
          providerName: 'composio',
        }),
      })
    })
    await page.getByTestId('directory-connect-api-slack').click()

    // Create account server-side
    const providerConnectionId = `e2e-policy-modal-agent-${Date.now()}`
    const res = await request.post(`${API}/api/connected-accounts`, {
      data: {
        providerConnectionId,
        toolkitSlug: 'slack',
        displayName: 'E2E Policy Modal Agent Slack',
      },
    })
    expect(res.ok()).toBeTruthy()
    const { account } = await res.json()

    // Simulate OAuth completion
    await page.evaluate(
      ({ accountId }) => {
        window.postMessage(
          { type: 'oauth-callback', success: true, accountId, toolkitSlug: 'slack' },
          window.location.origin,
        )
      },
      { accountId: account.id },
    )

    // Dialog should close
    await expect(dialog).toBeHidden({ timeout: 5000 })

    // Scope policy editor should open
    const scopeEditor = page.getByText('Successfully Connected!')
    await expect(scopeEditor).toBeVisible({ timeout: 5000 })
  })
})
