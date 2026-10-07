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
    await row.getByRole('button', { name: `Edit ${original.name}` }).click()
    await page.getByLabel('Name', { exact: true }).fill(renamed)
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.getByTestId('saved-volume-row').filter({ hasText: renamed })).toBeVisible()

    await page.goto(`/agents/${second.slug}`)
    await page.getByTestId('add-mount-menu').click()
    await expect(page.getByRole('menuitem', { name: /Add new folder/ })).not.toBeVisible()
    await page.getByRole('menuitem', { name: renamed, exact: false }).click()
    await expect(page.getByRole('button', { name: 'Mount actions' })).toBeVisible()
    const secondMounts = await (await request.get(`/api/agents/${second.slug}/mounts`)).json() as Array<{ id: string; volumeId: string; name: string }>
    expect(secondMounts).toMatchObject([{ volumeId, name: renamed }])
    expect(secondMounts[0].id).not.toBe(original.id)
    const firstMounts = await (await request.get(`/api/agents/${first.slug}/mounts`)).json()
    expect(firstMounts).toMatchObject([{ id: original.id, name: original.name, volumeId }])

    await page.getByRole('button', { name: 'Mount actions' }).click()
    await page.getByRole('button', { name: 'Remove Mount', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove Mount', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Mount actions' })).not.toBeVisible()
    expect((await request.delete(`/api/agents/${first.slug}/mounts/${original.id}`)).ok()).toBe(true)

    await page.goto('/settings/volumes')
    const unused = page.getByTestId('saved-volume-row').filter({ hasText: renamed })
    await expect(unused).toContainText('Not attached')
    await unused.getByRole('button', { name: `Delete ${renamed}` }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete volume' }).click()
    await expect(unused).not.toBeVisible()
    expect(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8')).toBe('Keep this file')
  } finally {
    await deleteAgentViaApi(request, first)
    await deleteAgentViaApi(request, second)
    if (volumeId) await request.delete(`/api/volume-definitions/${volumeId}`)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
