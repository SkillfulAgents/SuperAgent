import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'

const API = ''

/**
 * Opens Global Settings → Connections and clicks through to the detail page
 * for the named connection. The scope policy editor renders inline there
 * (the per-row policy pill + dialog were removed in the connections redesign).
 */
async function openConnectionDetail(page: Page, name: string) {
  await page.locator('[data-testid="settings-button"]').click()
  await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
  await page.locator('[data-testid="settings-nav-connections"]').click()

  const row = page.getByRole('button', { name: `Open ${name} connection details` })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.click()
  await expect(page.locator('[data-testid="connection-detail-back"]')).toBeVisible()
}

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

    // Settings → Connections → open the inline editor via the connection row.
    await openConnectionDetail(page, 'E2E Grouping Slack')

    // The three risk-label groups render (Slack has read/write/destructive scopes).
    await expect(page.locator('[data-testid="scope-group-read"]')).toBeVisible()
    await expect(page.locator('[data-testid="scope-group-write"]')).toBeVisible()
    await expect(page.locator('[data-testid="scope-group-destructive"]')).toBeVisible()

    // Each group header pre-fills the recommended baseline default.
    await expect(
      page.locator('[data-testid="group-default-read"] [data-testid="policy-dropdown-trigger"]'),
    ).toHaveAttribute('data-decision', 'allow')
    await expect(
      page.locator('[data-testid="group-default-write"] [data-testid="policy-dropdown-trigger"]'),
    ).toHaveAttribute('data-decision', 'review')
    await expect(
      page.locator('[data-testid="group-default-destructive"] [data-testid="policy-dropdown-trigger"]'),
    ).toHaveAttribute('data-decision', 'block')

    // Still display-only — nothing persisted until Save.
    const after = await (await request.get(`${API}/api/policies/scope/${account.id}`)).json()
    expect(after.policies).toHaveLength(0)
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

    // Settings → Connections → open the inline editor via the connection row.
    await openConnectionDetail(page, 'E2E Grouping Persist Slack')

    const destTrigger = () =>
      page.locator('[data-testid="group-default-destructive"] [data-testid="policy-dropdown-trigger"]')

    // Flip the Destructive group default from block → allow via the dropdown.
    await expect(destTrigger()).toHaveAttribute('data-decision', 'block')
    await destTrigger().click()
    await page.locator('[data-testid="policy-menu-allow"]').click()
    await expect(destTrigger()).toHaveAttribute('data-decision', 'allow')

    // Save — the inline editor stays on screen; verify persistence via API.
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(async () => {
        const body = await (await request.get(`${API}/api/policies/scope/${account.id}`)).json()
        return (body.policies as Array<{ scope: string; decision: string }>).find(
          (p) => p.scope === '*destructive',
        )?.decision
      }, { timeout: 5000 })
      .toBe('allow')

    // Reopen the editor by going back to the list and into the row again —
    // remounting the inline editor refetches the persisted policies.
    await page.locator('[data-testid="connection-detail-back"]').click()
    const row = page.getByRole('button', {
      name: 'Open E2E Grouping Persist Slack connection details',
    })
    await expect(row).toBeVisible({ timeout: 5000 })
    await row.click()
    await expect(destTrigger()).toHaveAttribute('data-decision', 'allow', { timeout: 5000 })
  })
})
