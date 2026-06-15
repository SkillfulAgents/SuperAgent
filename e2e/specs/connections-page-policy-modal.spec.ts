import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { getConnectionsHeaderAddButton } from '../helpers/connections'
import { getE2EBaseUrl } from '../helpers/base-url'

const API = getE2EBaseUrl()

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

    // 2. Open the "Add New Connection" directory dialog (APIs tab is default)
    const addButton = getConnectionsHeaderAddButton(page)
    await expect(addButton).toBeVisible()
    await addButton.click()

    const dialog = page.getByRole('dialog', { name: 'Add New Connection' })
    await expect(dialog).toBeVisible()

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
    const addButton = getConnectionsHeaderAddButton(page)
    await expect(addButton).toBeVisible()

    // Open the "Add New Connection" dialog
    await addButton.click()
    const dialog = page.getByRole('dialog', { name: 'Add New Connection' })
    await expect(dialog).toBeVisible()

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
