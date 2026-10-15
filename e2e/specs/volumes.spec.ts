import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createAgent, deleteAgentViaApi, uniqueName } from '../helpers/agents'

test('reuses a saved volume, edits its definition, and detaches without deleting files', async ({ page, request }, testInfo) => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-volume-e2e-')))
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'Keep this file')
  const first = await createAgent(request, uniqueName(testInfo, 'Volume owner'))
  const second = await createAgent(request, uniqueName(testInfo, 'Volume borrower'))
  let volumeId: string | undefined
  try {
    // The existing folder-picker request still creates and attaches in one call.
    const created = await request.post(`/api/agents/${first.slug}/mounts`, { data: { type: 'local', config: { path: folder } } })
    expect(created.status()).toBe(201)
    const original = await created.json() as { id: string; volumeId: string; name: string }
    volumeId = original.volumeId
    const renamed = uniqueName(testInfo, 'Shared notes')

    await page.goto('/settings/volumes')
    const row = page.getByTestId('saved-volume-row').filter({ hasText: original.name })
    await expect(row).toContainText('Used by 1 agent')
    await expect(row.getByRole('button', { name: `Delete ${original.name}` })).toBeDisabled()
    await row.click()
    await expect(page).toHaveURL(new RegExp(`volume=${volumeId}`))
    await page.getByRole('button', { name: 'Rename drive' }).click()
    await page.getByTestId('volume-title-input').fill(`${renamed} draft`)
    await page.getByTestId('volume-title-input').press('Enter')
    await expect(page.getByTestId('volume-title')).toHaveText(`${renamed} draft`)
    await page.getByRole('button', { name: 'Drives', exact: true }).click()
    await expect(page.getByTestId('saved-volume-row').filter({ hasText: `${renamed} draft` })).toBeVisible()

    await page.goto(`/agents/${first.slug}`)
    await page.getByRole('button', { name: `Open ${renamed} draft drive settings` }).hover()
    await page.getByRole('button', { name: 'Drive actions', exact: true }).click()
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByTestId('volume-row-name-input').fill(renamed)
    await page.getByTestId('volume-row-name-input').press('Enter')
    await expect(page.getByText(renamed, { exact: true })).toBeVisible()
    await expect(page.getByText(`/mounts/${original.name}`, { exact: true })).toBeVisible()

    await page.goto(`/agents/${second.slug}`)
    await page.getByTestId('add-mount-menu').click()
    await expect(page.getByRole('menuitem', { name: 'New Drive' })).toBeVisible()
    await page.getByRole('menuitem', { name: renamed, exact: false }).click()
    await expect(page.getByRole('button', { name: 'Drive actions' })).toBeVisible()
    const secondMounts = await (await request.get(`/api/agents/${second.slug}/mounts`)).json() as Array<{ id: string; volumeId: string; name: string }>
    expect(secondMounts).toMatchObject([{ volumeId, name: renamed }])
    expect(secondMounts[0].id).not.toBe(original.id)
    const firstMounts = await (await request.get(`/api/agents/${first.slug}/mounts`)).json()
    expect(firstMounts).toMatchObject([{ id: original.id, name: original.name, volumeId }])

    await page.getByRole('button', { name: 'Drive actions' }).click()
    await page.getByRole('button', { name: 'Remove from Agent', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove from Agent', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Drive actions' })).not.toBeVisible()
    expect((await request.delete(`/api/agents/${first.slug}/mounts/${original.id}`)).ok()).toBe(true)

    await page.goto('/settings/volumes')
    const unused = page.getByTestId('saved-volume-row').filter({ hasText: renamed })
    await expect(unused).toContainText('Not added')
    await unused.getByRole('button', { name: `Delete ${renamed}` }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete drive' }).click()
    await expect(unused).not.toBeVisible()
    expect(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8')).toBe('Keep this file')
  } finally {
    await deleteAgentViaApi(request, first)
    await deleteAgentViaApi(request, second)
    if (volumeId) await request.delete(`/api/volume-definitions/${volumeId}`)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
