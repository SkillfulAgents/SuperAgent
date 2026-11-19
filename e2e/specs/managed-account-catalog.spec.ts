import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'

test('new managed accounts are searchable and tenant-based accounts use the hosted connection flow', async ({ page }) => {
  const appPage = new AppPage(page)
  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await page.getByTestId('settings-button').click()
  await page.getByTestId('settings-nav-connections').click()
  await page.getByTestId('connections-add-button').first().click()
  const dialog = page.getByRole('dialog', { name: 'Add New Connection' })
  await expect(dialog).toBeVisible()
  await page.getByTestId('directory-tab-apis').click()
  const search = dialog.getByPlaceholder('Search APIs...')

  // Exercise different names/slugs and product editions through the real
  // providers API and directory search, without contacting OAuth providers.
  for (const [query, slug, name] of [
    ['OneDrive', 'one_drive', 'OneDrive'],
    ['NotebookLM', 'notebook_lm', 'NotebookLM Enterprise'],
    ['WhatsApp', 'whatsapp', 'WhatsApp Business'],
    ['Zoho Books', 'zoho_books', 'Zoho Books'],
  ]) {
    await search.fill(query)
    await expect(dialog.getByTestId(`directory-connect-api-${slug}`)).toBeVisible()
    await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  }

  // A toolkit requiring a subdomain must still reach the existing hosted
  // flow. Composio collects that field on its page, after our initiate call.
  await page.route('**/api/connected-accounts/initiate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connectionId: 'e2e-managed-jira',
        redirectUrl: 'about:blank',
        providerSlug: 'jira',
        providerName: 'composio',
      }),
    })
  })
  await search.fill('Jira')
  const initiated = page.waitForRequest('**/api/connected-accounts/initiate')
  await dialog.getByTestId('directory-connect-api-jira').click()
  expect((await initiated).postDataJSON()).toMatchObject({ providerSlug: 'jira' })
  await expect(dialog.getByTestId('directory-connect-api-jira')).toBeDisabled()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
})
