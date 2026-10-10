import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createAgent, deleteAgentViaApi, uniqueName } from '../helpers/agents'
import { mockDropboxVolumes } from '../helpers/dropbox-volumes'

test('manages a volume from its own page and browses files without starting an agent', async ({ page, request }, testInfo) => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volume-details-e2e-')))
  fs.mkdirSync(path.join(folder, 'Reports'))
  fs.writeFileSync(path.join(folder, 'Reports', 'Q1 # 日本語.md'), '# Quarterly report\n\nRevenue grew this quarter.')
  fs.writeFileSync(path.join(folder, 'Reports', 'budget.xlsx'), 'original workbook bytes')
  const agent = await createAgent(request, uniqueName(testInfo, 'Volume researcher'))
  let id: string | undefined
  try {
    const created = await request.post('/api/volume-definitions', { data: { name: uniqueName(testInfo, 'Team files'), type: 'local', config: { path: folder } } })
    expect(created.ok()).toBe(true)
    id = (await created.json()).id as string
    const definitions = await (await request.get('/api/volume-definitions')).json()
    const name = definitions.find((volume: { id: string }) => volume.id === id).name as string
    await page.goto('/settings/volumes')
    await page.getByRole('link', { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`volume=${id}`))
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const toggle = page.getByTestId(`volume-agent-toggle-${id}-${agent.slug}`)
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(toggle).toBeChecked()
    expect((await (await request.get(`/api/agents/${agent.slug}`)).json()).status).toBe('stopped')
    await page.reload()
    await expect(toggle).toBeChecked()
    await expect(page.getByRole('button', { name: 'Delete volume', exact: true })).toBeDisabled()

    await page.getByTestId('folder-entry').filter({ hasText: 'Reports' }).click()
    await page.getByTestId('folder-entry').filter({ hasText: 'Q1 # 日本語.md' }).click()
    const preview = page.getByTestId('volume-file-preview')
    await expect(preview.getByRole('heading', { name: 'Quarterly report' })).toBeVisible()
    await expect(preview).toContainText('Revenue grew this quarter.')
    const download = await preview.getByRole('link', { name: 'Download file' }).getAttribute('href')
    expect(await (await request.get(download!)).text()).toContain('Revenue grew this quarter.')
    await page.getByTestId('folder-entry').filter({ hasText: 'budget.xlsx' }).click()
    await expect(preview).toContainText('Preview is not available for this file type')
    const fallbackDownload = await preview.getByRole('link', { name: 'Download', exact: true }).getAttribute('href')
    expect(fallbackDownload).toContain(`/api/volume-definitions/${id}/file?`)

    await page.getByLabel('Filter files').fill('Q1')
    await expect(page.getByTestId('folder-entry').filter({ hasText: 'budget.xlsx' })).not.toBeVisible()
    await page.getByLabel('Filter files').fill('')
    await page.goto(`/agents/${agent.slug}`)
    await page.getByRole('button', { name: 'Mount actions' }).click()
    await page.getByRole('link', { name: 'Volume settings' }).click()
    await expect(page).toHaveURL(new RegExp(`volume=${id}`))
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    expect(await (await request.get(`/api/agents/${agent.slug}/mounts`)).json()).toEqual([])
    expect(fs.readFileSync(path.join(folder, 'Reports', 'budget.xlsx'), 'utf8')).toBe('original workbook bytes')
  } finally {
    await deleteAgentViaApi(request, agent)
    if (id) await request.delete(`/api/volume-definitions/${id}`)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('renders provider-owned logos on the homepage and in saved volumes', async ({ page, request }, testInfo) => {
  const agent = await createAgent(request, uniqueName(testInfo, 'Cloud files'))
  try {
    const state = await mockDropboxVolumes(page, agent.slug)
    for (const type of ['dropbox', 'googledrive'] as const) {
      const volume = { id: type, name: type === 'dropbox' ? 'Team Dropbox' : 'Team Drive', type, hostPath: null,
        sourceLabel: type === 'dropbox' ? 'Dropbox · /Team' : 'Google Drive · Team', health: 'ok' as const,
        userId: null, canManage: true, attachmentCount: 1 }
      state.definitions.push(volume)
      state.mounts.push({ ...volume, id: `mount-${type}`, volumeId: volume.id })
    }
    await page.goto(`/agents/${agent.slug}`)
    for (const type of ['dropbox', 'googledrive']) await expect(page.locator(`img[src*="${type}"]`).first()).toBeVisible()
    await page.goto('/settings/volumes')
    for (const type of ['dropbox', 'googledrive']) await expect(page.getByTestId('saved-volume-row').locator(`img[src*="${type}"]`)).toBeVisible()
  } finally { await deleteAgentViaApi(request, agent) }
})
