import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { AppPage } from '../pages/app.page'

type ScopeDecision = 'allow' | 'review' | 'block'
type ScopePolicy = { scope: string; decision: ScopeDecision }

async function createSlackAccount(
  request: APIRequestContext,
  label: string,
) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const displayName = `E2E Policy ${label} ${unique}`
  const res = await request.post('/api/connected-accounts', {
    data: {
      providerConnectionId: `e2e-policy-${unique}`,
      toolkitSlug: 'slack',
      displayName,
    },
  })
  expect(res.ok()).toBe(true)
  const body = await res.json()
  return { id: body.account.id as string, name: displayName }
}

/**
 * Opens Global Settings → Connections and clicks through to the detail page
 * for the named connection. The scope/tool policy editor renders inline there
 * (the per-row policy pill + dialog were removed in the connections redesign).
 */
async function openConnectionDetail(page: Page, name: string) {
  // Settings now lives inside the footer account menu
  await page.locator('[data-testid="user-menu-trigger"]').click()
  await page.locator('[data-testid="settings-button"]').click()
  await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
  await page.locator('[data-testid="settings-nav-connections"]').click()

  await openConnectionRow(page, name)
}

async function openConnectionRow(page: Page, name: string) {
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

async function seedScopePolicies(
  request: APIRequestContext,
  accountId: string,
  policies: ScopePolicy[],
) {
  const res = await request.put(`/api/policies/scope/${accountId}`, {
    data: { policies },
  })
  expect(res.ok()).toBe(true)
}

async function scopePolicies(request: APIRequestContext, accountId: string) {
  const res = await request.get(`/api/policies/scope/${accountId}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  return body.policies as ScopePolicy[]
}

function chatWriteRow(page: Page) {
  return page.locator('[data-testid="scope-row-chat:write"]')
}

async function openChatWriteGroup(page: Page) {
  await page.locator('[data-testid="scope-group-toggle-write"]').click()
  const row = chatWriteRow(page)
  await expect(row).toBeVisible({ timeout: 5000 })
  return row
}

test.describe('Policy Settings', () => {
  let appPage: AppPage

  const openPolicyEditor = async (page: Page, accountName: string) => {
    appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openConnectionDetail(page, accountName)
  }

  test('settings: connection row opens the detail page with the inline scope editor', async ({ page, request }) => {
    const account = await createSlackAccount(request, 'Open')

    await openPolicyEditor(page, account.name)

    // The scope policy editor renders inline in the Permissions column.
    await expect(page.getByRole('heading', { name: account.name })).toBeVisible()
    await expect(page.getByText('Permissions')).toBeVisible()
    await expect(page.locator('[data-testid="scope-group-write"]')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="scope-policy-save"]')).toBeVisible()
  })

  test('settings: can set a scope policy from the detail page', async ({ page, request }) => {
    const account = await createSlackAccount(request, 'Allow')
    await openPolicyEditor(page, account.name)

    // Find the chat:write scope row and set it to "allow".
    // The Write group is an accordion collapsed by default — expand it first.
    const chatWrite = await openChatWriteGroup(page)

    // The allow toggle should not be active
    const allowToggle = chatWrite.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'false')

    // Click the allow toggle
    await allowToggle.click()
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    // Save — the inline editor stays on screen; verify persistence via API.
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request, account.id)).find((p) => p.scope === 'chat:write')?.decision,
        { timeout: 5000 },
      )
      .toBe('allow')
  })

  test('settings: saved policy persists after reopening the editor', async ({ page, request }) => {
    const account = await createSlackAccount(request, 'Reopen')
    await openPolicyEditor(page, account.name)

    const chatWrite = await openChatWriteGroup(page)
    const allowToggle = chatWrite.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'false')
    await allowToggle.click()
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request, account.id)).find((p) => p.scope === 'chat:write')?.decision,
        { timeout: 5000 },
      )
      .toBe('allow')

    // Reopen the editor so the UI refetches persisted policies, rather than
    // only asserting the optimistic in-memory state from the first mount.
    await page.locator('[data-testid="connection-detail-back"]').click()
    await openConnectionRow(page, account.name)
    const reopenedChatWrite = await openChatWriteGroup(page)
    await expect(reopenedChatWrite.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'true')
  })

  test('settings: can change policy from allow to block', async ({ page, request }) => {
    const account = await createSlackAccount(request, 'Block')
    await seedScopePolicies(request, account.id, [{ scope: 'chat:write', decision: 'allow' }])

    await openPolicyEditor(page, account.name)

    const chatWrite = await openChatWriteGroup(page)

    // Allow should be active from this test's seeded starting policy.
    const allowToggle = chatWrite.locator('[data-testid="policy-toggle-allow"]')
    await expect(allowToggle).toHaveAttribute('data-active', 'true')

    // Click block toggle instead
    const blockToggle = chatWrite.locator('[data-testid="policy-toggle-block"]')
    await blockToggle.click()

    // Allow should now be inactive, block active
    await expect(allowToggle).toHaveAttribute('data-active', 'false')
    await expect(blockToggle).toHaveAttribute('data-active', 'true')

    // Save and verify the flip persisted.
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request, account.id)).find((p) => p.scope === 'chat:write')?.decision,
        { timeout: 5000 },
      )
      .toBe('block')
  })

  test('settings: can deselect to reset to default', async ({ page, request }) => {
    const account = await createSlackAccount(request, 'Default')
    await seedScopePolicies(request, account.id, [{ scope: 'chat:write', decision: 'block' }])

    await openPolicyEditor(page, account.name)

    const chatWrite = await openChatWriteGroup(page)

    // Block should be active from this test's seeded starting policy.
    const blockToggle = chatWrite.locator('[data-testid="policy-toggle-block"]')
    await expect(blockToggle).toHaveAttribute('data-active', 'true')

    // Click block again to deselect (reset to default)
    await blockToggle.click()
    await expect(blockToggle).toHaveAttribute('data-active', 'false')

    // All toggles should be inactive (= default)
    await expect(chatWrite.locator('[data-testid="policy-toggle-allow"]')).toHaveAttribute('data-active', 'false')
    await expect(chatWrite.locator('[data-testid="policy-toggle-review"]')).toHaveAttribute('data-active', 'false')
    await expect(chatWrite.locator('[data-testid="policy-toggle-block"]')).toHaveAttribute('data-active', 'false')

    // Save and verify the per-scope row is gone from the persisted policies
    // (label-default rows may remain — only chat:write must be absent).
    await page.locator('[data-testid="scope-policy-save"]').click()
    await expect
      .poll(
        async () => (await scopePolicies(request, account.id)).some((p) => p.scope === 'chat:write'),
        { timeout: 5000 },
      )
      .toBe(false)
  })
})
