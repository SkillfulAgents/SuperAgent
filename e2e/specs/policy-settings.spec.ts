import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test.describe.configure({ mode: 'serial' })

/**
 * Opens Global Settings → Connections and clicks through to the detail page
 * for the named connection. The scope/tool policy editor renders inline there
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
  // The open detail is URL-driven now (deep-linkable + reload-durable), parity
  // with the agent connections route — opening a row changes the URL. (`?from`
  // may precede it, so assert path + param independently.)
  await expect(page).toHaveURL(/\/settings\/connections\?/)
  await expect(page).toHaveURL(/detail=account-/)
}

test.describe('Policy Settings', () => {
  let appPage: AppPage
  let accountId: string
  const accountName = 'E2E Slack Account'

  test.beforeAll(async ({ request }) => {
    // Unique per run so a retry (which re-runs beforeAll in a new worker) does
    // not collide with the previously-seeded row on the unique connectionId.
    const providerConnectionId = `e2e-test-connection-${Date.now()}`
    const res = await request.post('/api/connected-accounts', {
      data: {
        providerConnectionId,
        toolkitSlug: 'slack',
        displayName: accountName,
      },
    })
    const body = await res.json()
    accountId = body.account.id
  })

  // The inline editor has no dialog-close to await after Save, so persistence
  // is asserted against the API instead of pill text (the pill is gone).
  const scopePolicies = async (request: APIRequestContext) => {
    const res = await request.get(`/api/policies/scope/${accountId}`)
    const body = await res.json()
    return body.policies as Array<{ scope: string; decision: string }>
  }

  test('settings: connection row opens the detail page with the inline scope editor', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await openConnectionDetail(page, accountName)

    // The scope policy editor renders inline in the Permissions column.
    await expect(page.getByText('Permissions')).toBeVisible()
    await expect(page.locator('[data-testid="scope-group-write"]')).toBeVisible({ timeout: 5000 })
  })

  test('settings: can set a scope policy from the detail page', async ({ page, request }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await openConnectionDetail(page, accountName)

    // Find the chat:write scope row and set it to "allow".
    // The Write group is an accordion collapsed by default — expand it first.
    await page.locator('[data-testid="scope-group-toggle-write"]').click()
    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })

    // The allow toggle should not be active
    const allowToggle = chatWriteRow.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'false')

    // Click the allow toggle
    await allowToggle.click()
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    // Save — the inline editor stays on screen; verify persistence via API.
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request)).find((p) => p.scope === 'chat:write')?.decision,
        { timeout: 5000 },
      )
      .toBe('allow')
  })

  test('settings: saved policy persists after reopening the editor', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await openConnectionDetail(page, accountName)

    // The chat:write scope should still have allow active (from previous test)
    // The Write group is an accordion collapsed by default — expand it first.
    await page.locator('[data-testid="scope-group-toggle-write"]').click()
    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })
    const allowToggle = chatWriteRow.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'true')
  })

  test('settings: can change policy from allow to block', async ({ page, request }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await openConnectionDetail(page, accountName)

    // The Write group is an accordion collapsed by default — expand it first.
    await page.locator('[data-testid="scope-group-toggle-write"]').click()
    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })

    // Allow should be active from previous test
    const allowToggle = chatWriteRow.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    // Click block toggle instead
    const blockToggle = chatWriteRow.locator('[data-testid="policy-toggle-block"]')
    await blockToggle.click()

    // Allow should now be inactive, block active
    await expect(allowToggle).toHaveAttribute('data-active', 'false')
    await expect(blockToggle).toHaveAttribute('data-active', 'true')

    // Save and verify the flip persisted.
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request)).find((p) => p.scope === 'chat:write')?.decision,
        { timeout: 5000 },
      )
      .toBe('block')
  })

  test('settings: can deselect to reset to default', async ({ page, request }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    await openConnectionDetail(page, accountName)

    // The Write group is an accordion collapsed by default — expand it first.
    await page.locator('[data-testid="scope-group-toggle-write"]').click()
    const chatWriteRow = page.locator('[data-testid="scope-row-chat:write"]')
    await expect(chatWriteRow).toBeVisible({ timeout: 5000 })

    // Block should be active from previous test
    const blockToggle = chatWriteRow.locator('[data-testid="policy-toggle-block"]')
    await expect(blockToggle).toHaveAttribute('data-active', 'true')

    // Click block again to deselect (reset to default)
    await blockToggle.click()
    await expect(blockToggle).toHaveAttribute('data-active', 'false')

    // All toggles should be inactive (= default)
    await expect(chatWriteRow.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'false')
    await expect(chatWriteRow.locator('[data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'false')
    await expect(chatWriteRow.locator('[data-testid="policy-toggle-block"]')).toHaveAttribute('data-active', 'false')

    // Save and verify the per-scope row is gone from the persisted policies
    // (label-default rows may remain — only chat:write must be absent).
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request)).some((p) => p.scope === 'chat:write'),
        { timeout: 5000 },
      )
      .toBe(false)
  })

  test('settings: global default policy toggle works', async ({ page }) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open settings → Accounts
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
    await page.locator('[data-testid="settings-nav-connections"]').click()

    // The API default-policy row inside the "Default Policies" card.
    const globalSection = page.locator('[data-testid="default-policy-api"]')
    const reviewToggle = globalSection.locator('[data-testid="policy-toggle-review"]')
    const allowToggle = globalSection.locator('[data-testid="policy-toggle-allow"]')

    // Review is default, should be active
    await expect(reviewToggle).toHaveAttribute('data-active', 'true')

    // Switch to allow
    await allowToggle.click()
    await expect(allowToggle).toHaveAttribute('data-active', 'true')
    await expect(reviewToggle).toHaveAttribute('data-active', 'false')
  })
})
