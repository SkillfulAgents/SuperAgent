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
    await expect(page.getByRole('menuitem', { name: 'New Volume' })).toBeVisible()
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


test('creates a volume from the dropdown even when every saved volume is already mounted', async ({ page, request }, testInfo) => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-volume-e2e-')))
  const agent = await createAgent(request, uniqueName(testInfo, 'New volume'))
  const volumeIds: string[] = []
  try {
    const existing = await request.post(`/api/agents/${agent.slug}/mounts`, { data: { type: 'local', config: { path: folder } } })
    expect(existing.status()).toBe(201)
    volumeIds.push((await existing.json()).volumeId)
    await page.goto(`/agents/${agent.slug}`)
    await page.getByTestId('add-mount-menu').click()
    await expect(page.getByRole('menuitem').last()).toHaveText('New Volume')
    await page.getByRole('menuitem', { name: 'New Volume' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAccessibleName('New Volume')
    await expect(dialog.getByRole('button', { name: 'Browse' })).not.toBeVisible()
    const name = uniqueName(testInfo, 'Reports')
    await dialog.getByLabel('Name', { exact: true }).fill(name)
    await dialog.getByLabel('Folder', { exact: true }).fill(path.join(folder, 'missing'))
    await dialog.getByRole('button', { name: 'Create and attach' }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByLabel('Name')).toHaveValue(name)
    const rejectedList = await (await request.get('/api/volume-definitions')).json() as Array<{ name: string }>
    expect(rejectedList.some(v => v.name === name)).toBe(false)

    await dialog.getByLabel('Folder', { exact: true }).fill(folder)
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/mounts'))
    await dialog.getByRole('button', { name: 'Create and attach' }).click()
    const response = await saved
    expect(response.status()).toBe(201)
    const created = await response.json() as { volumeId: string }
    volumeIds.push(created.volumeId)
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
    const mounts = await (await request.get(`/api/agents/${agent.slug}/mounts`)).json()
    expect(mounts).toHaveLength(2)
    expect(mounts).toContainEqual(expect.objectContaining({ volumeId: created.volumeId, name }))
    await page.goto('/settings/volumes')
    await expect(page.getByTestId('saved-volume-row').filter({ hasText: name })).toContainText('Used by 1 agent')
  } finally {
    await deleteAgentViaApi(request, agent)
    for (const id of volumeIds) await request.delete(`/api/volume-definitions/${id}`)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
