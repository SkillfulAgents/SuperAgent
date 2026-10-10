import { test, expect, type Page } from '@playwright/test'
import { createAgent, deleteAgentViaApi, uniqueName } from '../helpers/agents'
import { mockDropboxVolumes } from '../helpers/dropbox-volumes'

test.setTimeout(60_000)

async function chooseAccount(page: Page) {
  await page.getByRole('button', { name: 'Dropbox', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Name', { exact: true })).not.toBeVisible()
  await page.getByLabel('Dropbox account', { exact: true }).click()
  await expect(page.getByRole('option', { name: /Old Dropbox/ })).toBeDisabled()
  await page.getByRole('option', { name: 'Team Dropbox', exact: true }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByTestId('volume-settings-dialog').getByRole('textbox')).toHaveCount(1)
  await page.getByRole('button', { name: 'Select folder', exact: true }).click()
}

test('creates a scoped Dropbox volume from Settings without a path field', async ({ page }) => {
  const state = await mockDropboxVolumes(page)
  await page.goto('/settings/volumes')
  await page.getByRole('button', { name: 'Add volume' }).click()
  await expect(page.getByRole('button', { name: 'Local folder', exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await chooseAccount(page)
  await page.getByRole('button', { name: 'Team documents', exact: true }).click()
  await page.getByRole('button', { name: 'Reports', exact: true }).click()
  await expect(page.getByTestId('dropbox-folder-picker')).toContainText('No subfolders')
  await page.getByRole('button', { name: 'Use this folder' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Reports')
  await expect(page.getByTestId('selected-volume-folder')).toHaveText('/Team documents/Reports')
  await page.getByRole('button', { name: 'Create volume', exact: true }).click()
  await expect(page.getByTestId('volume-settings-dialog')).not.toBeVisible()
  await expect(page.getByTestId('saved-volume-row')).toContainText('Dropbox · /Team documents/Reports')
  expect(state.created).toEqual([{ type: 'dropbox', name: 'Reports', config: { accountId: 'dropbox-test', path: '/Team documents/Reports' }, visibility: 'public' }])
})

test('creates and attaches the Dropbox root from Add Mount', async ({ page, request }, testInfo) => {
  const agent = await createAgent(request, uniqueName(testInfo, 'Dropbox agent'))
  try {
    const state = await mockDropboxVolumes(page, agent.slug)
    await page.goto(`/agents/${agent.slug}`)
    await page.getByRole('button', { name: 'Add Mount', exact: true }).click()
    await chooseAccount(page)
    await page.getByRole('button', { name: 'Use Dropbox root' }).click()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Dropbox')
    await page.getByRole('button', { name: 'Create and attach' }).click()
    await expect(page.getByTestId('volume-settings-dialog')).not.toBeVisible()
    await expect(page.getByText('Dropbox · /', { exact: true })).toBeVisible()
    expect(state.created).toEqual([{ type: 'dropbox', config: { accountId: 'dropbox-test', path: '' }, name: 'Dropbox', visibility: 'public' }])
    expect(state.mounts).toHaveLength(1)
    await page.getByTestId('add-mount-menu').click()
    const create = page.getByRole('menuitem', { name: 'New Volume' })
    await expect(create).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Dropbox.*Mounted/ })).toBeDisabled()
  } finally { await deleteAgentViaApi(request, agent) }
})

test('keeps folder errors visible and retries before allowing selection', async ({ page }) => {
  const state = await mockDropboxVolumes(page)
  state.failFolders(true)
  await page.goto('/settings/volumes')
  await page.getByRole('button', { name: 'Add volume' }).click()
  await chooseAccount(page)
  await expect(page.getByRole('alert')).toHaveText('Reconnect this Dropbox account in Connections')
  await expect(page.getByRole('button', { name: 'Use Dropbox root' })).toBeDisabled()
  state.failFolders(false)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('button', { name: 'Team documents', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Use Dropbox root' }).click()
  await expect(page.getByRole('button', { name: 'Create volume', exact: true })).toBeEnabled()
})
