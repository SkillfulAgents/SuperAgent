import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'

const API = ''

type AccountStatus = 'active' | 'revoked' | 'expired'
type ToolkitSlug = 'slack' | 'github' | 'gmail'

interface ConnectedAccount {
  id: string
  providerConnectionId: string
  toolkitSlug: ToolkitSlug
  displayName: string
  status: AccountStatus
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
  options: {
    displayNamePrefix: string
    toolkitSlug: ToolkitSlug
    status: AccountStatus
  },
): Promise<ConnectedAccount> {
  const suffix = uniqueSuffix(testInfo)
  const providerConnectionId = `e2e-${options.toolkitSlug}-${options.status}-${suffix}`
  const displayName = `${options.displayNamePrefix} ${suffix}`

  const response = await request.post(`${API}/api/connected-accounts`, {
    data: {
      providerConnectionId,
      toolkitSlug: options.toolkitSlug,
      displayName,
      status: options.status,
    },
  })

  expect(response.ok()).toBeTruthy()
  const { account } = await response.json() as { account: ConnectedAccount }
  expect(account.id).toBeTruthy()
  expect(account.providerConnectionId).toBe(providerConnectionId)
  expect(account.toolkitSlug).toBe(options.toolkitSlug)
  expect(account.displayName).toBe(displayName)
  expect(account.status).toBe(options.status)

  return account
}

async function deleteConnectedAccounts(
  request: APIRequestContext,
  accounts: Array<Pick<ConnectedAccount, 'id'>>,
) {
  await Promise.all(accounts.map((account) => (
    request.delete(`${API}/api/connected-accounts/${account.id}`).catch(() => {})
  )))
}

async function listConnectedAccounts(request: APIRequestContext): Promise<ConnectedAccount[]> {
  const response = await request.get(`${API}/api/connected-accounts`)
  expect(response.ok()).toBeTruthy()

  const { accounts } = await response.json() as { accounts: ConnectedAccount[] }
  return accounts
}

function findAccount(accounts: ConnectedAccount[], accountId: string): ConnectedAccount {
  const account = accounts.find((candidate) => candidate.id === accountId)
  expect(account, `account ${accountId} missing from /api/connected-accounts`).toBeDefined()
  return account!
}

function connectionRow(page: Page, account: Pick<ConnectedAccount, 'displayName'>) {
  return page.getByRole('button', {
    name: `Open ${account.displayName} connection details`,
    exact: true,
  })
}

async function openConnectionsSettings(page: Page) {
  const appPage = new AppPage(page)
  await appPage.goto()
  await appPage.waitForAgentsLoaded()

  // Settings now lives inside the footer account menu

  await page.locator('[data-testid="user-menu-trigger"]').click()

  await page.locator('[data-testid="settings-button"]').click()
  await expect(page.locator('[data-testid="global-settings-page"]')).toBeVisible()
  await page.locator('[data-testid="settings-nav-connections"]').click()
}

test.describe('Account Status & Reconnect', () => {
  test('connections settings tab shows status badges for non-active accounts', async ({ page, request }, testInfo) => {
    const seededAccounts: ConnectedAccount[] = []

    try {
      const active = await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E Active Slack',
        toolkitSlug: 'slack',
        status: 'active',
      })
      seededAccounts.push(active)

      const revoked = await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E Revoked GitHub',
        toolkitSlug: 'github',
        status: 'revoked',
      })
      seededAccounts.push(revoked)

      const expired = await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E Expired Gmail',
        toolkitSlug: 'gmail',
        status: 'expired',
      })
      seededAccounts.push(expired)

      await openConnectionsSettings(page)

      const activeRow = connectionRow(page, active)
      const revokedRow = connectionRow(page, revoked)
      const expiredRow = connectionRow(page, expired)

      await expect(activeRow).toBeVisible()
      await expect(activeRow).toContainText(active.displayName)
      await expect(activeRow).toContainText('API')
      await expect(activeRow).toContainText('Slack')
      await expect(activeRow).not.toContainText(/Revoked|Expired/)

      await expect(revokedRow).toBeVisible()
      await expect(revokedRow).toContainText(revoked.displayName)
      await expect(revokedRow).toContainText('GitHub')
      await expect(revokedRow).toContainText('Revoked')

      await expect(expiredRow).toBeVisible()
      await expect(expiredRow).toContainText(expired.displayName)
      await expect(expiredRow).toContainText('Gmail')
      await expect(expiredRow).toContainText('Expired')

      const accounts = await listConnectedAccounts(request)
      expect(findAccount(accounts, active.id).status).toBe('active')
      expect(findAccount(accounts, revoked.id).status).toBe('revoked')
      expect(findAccount(accounts, expired.id).status).toBe('expired')
    } finally {
      await deleteConnectedAccounts(request, seededAccounts)
    }
  })

  test('reconnect completion preserves the target account when the mock provider cannot complete', async ({ request, page }, testInfo) => {
    const seededAccounts: ConnectedAccount[] = []

    try {
      const revoked = await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E Reconnect GitHub',
        toolkitSlug: 'github',
        status: 'revoked',
      })
      seededAccounts.push(revoked)

      const newConnectionId = `e2e-reconnected-${uniqueSuffix(testInfo)}`
      const completeRes = await request.post(`${API}/api/connected-accounts/complete`, {
        data: {
          connectionId: newConnectionId,
          toolkit: 'github',
          providerName: 'composio',
          reconnectAccountId: revoked.id,
        },
      })

      const accounts = await listConnectedAccounts(request)
      const updated = findAccount(accounts, revoked.id)

      if (completeRes.ok()) {
        const { account } = await completeRes.json() as { account: ConnectedAccount }
        expect(account.id).toBe(revoked.id)
        expect(updated.status).toBe('active')
        expect(updated.providerConnectionId).toBe(newConnectionId)

        await openConnectionsSettings(page)
        const updatedRow = connectionRow(page, updated)
        await expect(updatedRow).toBeVisible()
        await expect(updatedRow).not.toContainText('Revoked')
      } else {
        const failure = await completeRes.json().catch(() => ({})) as { error?: string }
        expect(failure.error).toBeTruthy()
        expect(updated.status).toBe('revoked')
        expect(updated.providerConnectionId).toBe(revoked.providerConnectionId)
        expect(updated.displayName).toBe(revoked.displayName)

        await openConnectionsSettings(page)
        const revokedRow = connectionRow(page, revoked)
        await expect(revokedRow).toBeVisible()
        await expect(revokedRow).toContainText('Revoked')
      }
    } finally {
      await deleteConnectedAccounts(request, seededAccounts)
    }
  })

  test('connections list returns each seeded account by id with exact status', async ({ request }, testInfo) => {
    const seededAccounts: ConnectedAccount[] = []

    try {
      seededAccounts.push(await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E API Active Slack',
        toolkitSlug: 'slack',
        status: 'active',
      }))
      seededAccounts.push(await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E API Revoked GitHub',
        toolkitSlug: 'github',
        status: 'revoked',
      }))
      seededAccounts.push(await createConnectedAccount(request, testInfo, {
        displayNamePrefix: 'E2E API Expired Gmail',
        toolkitSlug: 'gmail',
        status: 'expired',
      }))

      const accounts = await listConnectedAccounts(request)
      for (const seeded of seededAccounts) {
        expect(findAccount(accounts, seeded.id)).toMatchObject({
          id: seeded.id,
          providerConnectionId: seeded.providerConnectionId,
          toolkitSlug: seeded.toolkitSlug,
          displayName: seeded.displayName,
          status: seeded.status,
        })
      }
    } finally {
      await deleteConnectedAccounts(request, seededAccounts)
    }
  })
})
