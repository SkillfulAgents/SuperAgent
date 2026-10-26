import { test, expect, type Page } from '@playwright/test'
import { createAgent, deleteAgentViaApi, uniqueName } from '../helpers/agents'
import { mockDropboxVolumes } from '../helpers/dropbox-volumes'

test.setTimeout(60_000)

async function chooseAccount(page: Page) {
  await page.getByRole('button', { name: 'Dropbox', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('radio', { name: 'Old Dropbox', exact: true })).toBeDisabled()
  // The only usable account is chosen for you.
  await expect(page.getByRole('radio', { name: 'Team Dropbox', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByTestId('volume-settings-dialog').getByRole('textbox')).toHaveCount(1)
  await page.getByRole('button', { name: /^Select folder location/ }).click()
}

test('creates a scoped Dropbox volume from Settings without a path field', async ({ page }) => {
  const state = await mockDropboxVolumes(page)
  await page.goto('/settings/volumes')
  await page.getByRole('button', { name: 'Add drive' }).click()
  await expect(page.getByRole('button', { name: 'Local folder', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await chooseAccount(page)
  await page.getByRole('button', { name: 'Open Team documents', exact: true }).click()
  await page.getByRole('button', { name: 'Open Reports', exact: true }).click()
  await expect(page.getByTestId('dropbox-folder-picker')).toContainText('No folders in Reports')
  await page.getByRole('button', { name: 'Use “Reports”' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Reports')
  await expect(page.getByTestId('selected-volume-folder')).toHaveText('/Team documents/Reports')
  await page.getByRole('button', { name: 'Create drive', exact: true }).click()
  await expect(page.getByTestId('volume-settings-dialog')).not.toBeVisible()
  await expect(page.getByTestId('saved-volume-row')).toContainText('Dropbox · /Team documents/Reports')
  expect(state.created).toEqual([{ type: 'dropbox', name: 'Reports', config: { accountId: 'dropbox-test', path: '/Team documents/Reports' }, visibility: 'public' }])
})

test('creates and attaches the Dropbox root from Add Drive', async ({ page, request }, testInfo) => {
  const agent = await createAgent(request, uniqueName(testInfo, 'Dropbox agent'))
  try {
    const state = await mockDropboxVolumes(page, agent.slug)
    await page.goto(`/agents/${agent.slug}`)
    await page.getByRole('button', { name: 'Add Drive', exact: true }).click()
    await chooseAccount(page)
    await page.getByRole('button', { name: 'Use all of Dropbox' }).click()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Dropbox')
    await page.getByRole('button', { name: 'Create and add' }).click()
    await expect(page.getByTestId('volume-settings-dialog')).not.toBeVisible()
    await expect(page.getByText('Dropbox · /', { exact: true })).toBeVisible()
    expect(state.created).toEqual([{ type: 'dropbox', config: { accountId: 'dropbox-test', path: '' }, name: 'Dropbox', visibility: 'public' }])
    expect(state.mounts).toHaveLength(1)
    await page.getByTestId('add-mount-menu').click()
    const create = page.getByRole('menuitem', { name: 'New Drive' })
    await expect(create).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Dropbox.*Added/ })).toBeDisabled()
  } finally { await deleteAgentViaApi(request, agent) }
})

test('keeps folder errors visible and retries before allowing selection', async ({ page }) => {
  const state = await mockDropboxVolumes(page)
  state.failFolders(true)
  await page.goto('/settings/volumes')
  await page.getByRole('button', { name: 'Add drive' }).click()
  await chooseAccount(page)
  await expect(page.getByRole('alert')).toHaveText('Reconnect this Dropbox account in Connections')
  await expect(page.getByRole('button', { name: 'Use all of Dropbox' })).toBeDisabled()
  state.failFolders(false)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('button', { name: 'Team documents', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Use all of Dropbox' }).click()
  await expect(page.getByRole('button', { name: 'Create drive', exact: true })).toBeEnabled()
})

test('connects a first Dropbox account from the set-up and goes straight on to the folder', async ({ page, context, baseURL }) => {
  await mockDropboxVolumes(page)
  let accounts: unknown[] = []
  await page.route('**/api/connected-accounts', route => route.fulfill({ json: { accounts } }))
  await page.route('**/api/connected-accounts/initiate', route => route.fulfill({ json: { connectionId: 'conn-1', providerSlug: 'dropbox', redirectUrl: `${baseURL}/dropbox-sign-in` } }))
  await context.route('**/dropbox-sign-in', route => route.fulfill({ contentType: 'text/html', body: '<p>Sign in to Dropbox</p>' }))
  await page.goto('/settings/volumes')
  await page.getByRole('button', { name: 'Add drive' }).click()
  await page.getByRole('button', { name: 'Dropbox', exact: true }).click()
  await expect(page.getByRole('radiogroup')).toHaveCount(0)
  const popupOpened = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Connect Dropbox', exact: true }).click()
  const popup = await popupOpened
  await expect(popup.getByText('Sign in to Dropbox')).toBeVisible()
  accounts = [{ id: 'dropbox-test', toolkitSlug: 'dropbox', providerName: 'composio', displayName: 'Team Dropbox', status: 'active' }]
  await popup.evaluate(() => { window.opener.postMessage({ type: 'oauth-callback', success: true, accountId: 'dropbox-test', toolkitSlug: 'dropbox' }, location.origin) })
  await expect(page.getByRole('button', { name: /^Select folder location/ })).toBeVisible()
})
