import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'

// web-chromium's request fixture has no baseURL configured, so use an absolute
// API base (matches connections-page-policy-modal.spec.ts).
const API = 'http://localhost:3000'

test.describe('Scope Policy Editor — risk-label grouping', () => {
  test('groups scopes by risk label and pre-fills the recommended defaults', async ({ page, request }) => {
    // Create a Slack account server-side (same path the OAuth callback uses).
    // Connecting does NOT persist any policy — the editor only pre-fills the
    // recommended baseline ('*read'=allow, '*write'=review, '*destructive'=block)
    // and persists it on Save.
    const res = await request.post(`${API}/api/connected-accounts`, {
      data: {
        providerConnectionId: `e2e-grouping-${Date.now()}`,
        toolkitSlug: 'slack',
        displayName: 'E2E Grouping Slack',
      },
    })
    expect(res.ok()).toBeTruthy()
    const { account } = await res.json()

    // Nothing should be persisted at connect time — the baseline is display-only.
    const before = await (await request.get(`${API}/api/policies/scope/${account.id}`)).json()
    expect(before.policies).toHaveLength(0)

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Settings → Connections → open the policy editor via the pill
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-connections"]').click()

    const pill = page.locator(`[data-testid="policy-pill-${account.id}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    // No persisted policies → pill stays "Protected", not "Custom".
    await expect(pill).not.toContainText('Custom')
    await pill.click()

    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })

    // The three risk-label groups render (Slack has read/write/destructive scopes).
    await expect(page.locator('[data-testid="scope-group-read"]')).toBeVisible()
    await expect(page.locator('[data-testid="scope-group-write"]')).toBeVisible()
    await expect(page.locator('[data-testid="scope-group-destructive"]')).toBeVisible()

    // Each group header pre-fills the recommended baseline default.
    await expect(
      page.locator('[data-testid="group-default-read"] [data-testid="policy-toggle-allow"]'),
    ).toHaveAttribute('data-active', 'true')
    await expect(
      page.locator('[data-testid="group-default-write"] [data-testid="policy-toggle-review"]'),
    ).toHaveAttribute('data-active', 'true')
    await expect(
      page.locator('[data-testid="group-default-destructive"] [data-testid="policy-toggle-block"]'),
    ).toHaveAttribute('data-active', 'true')
  })

  test('changing a group default persists and is reflected on reopen', async ({ page, request }) => {
    const res = await request.post(`${API}/api/connected-accounts`, {
      data: {
        providerConnectionId: `e2e-grouping-persist-${Date.now()}`,
        toolkitSlug: 'slack',
        displayName: 'E2E Grouping Persist Slack',
      },
    })
    expect(res.ok()).toBeTruthy()
    const { account } = await res.json()

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Connections and the policy editor via the pill.
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-connections"]').click()
    const pill = page.locator(`[data-testid="policy-pill-${account.id}"]`)
    await expect(pill).toBeVisible({ timeout: 5000 })
    await pill.click()
    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })

    const destAllow = () =>
      page.locator('[data-testid="group-default-destructive"] [data-testid="policy-toggle-allow"]')

    // Flip the Destructive group default from block → allow.
    await expect(destAllow()).toHaveAttribute('data-active', 'false')
    await destAllow().click()
    await expect(destAllow()).toHaveAttribute('data-active', 'true')

    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect(page.getByText('Scope Policies')).not.toBeVisible({ timeout: 5000 })

    // Deviating from the baseline now marks the account "Custom".
    await expect(pill).toContainText('Custom', { timeout: 5000 })

    // Reopen via the pill (we're still on the connections tab — the app shell,
    // and its settings button, is unmounted while settings is open).
    await pill.click()
    await expect(page.getByText('Scope Policies')).toBeVisible({ timeout: 5000 })
    await expect(destAllow()).toHaveAttribute('data-active', 'true')
  })
})
