import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, expect, type BrowserContext } from '@playwright/test'

// A freshly signed-up owner keeps this isolated: "all my agents" only reaches agents they own.
test('adding a drive to all my private agents reaches private agents now and later, not shared ones', async ({ browser, page, baseURL }) => {
  const stamp = Date.now()
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drive-defaults-e2e-')))
  const teammate: BrowserContext = await browser.newContext({ baseURL })
  let driveId: string | undefined
  const agents: string[] = []
  try {
    const owner = await page.request.post('/api/auth/sign-up/email', { data: { name: 'Dana Drives', email: `drives-${stamp}-owner@example.test`, password: 'CollaborationTesting123!' } })
    expect(owner.ok()).toBeTruthy()
    const mate = await teammate.request.post('/api/auth/sign-up/email', { data: { name: 'Theo Team', email: `drives-${stamp}-mate@example.test`, password: 'CollaborationTesting123!' } })
    expect(mate.ok()).toBeTruthy()
    const mateId = (await mate.json()).user.id as string
    expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()

    const createAgent = async (name: string) => {
      const slug = (await (await page.request.post('/api/agents', { data: { name } })).json()).slug as string
      agents.push(slug)
      return slug
    }
    const drives = async (slug: string) => (await (await page.request.get(`/api/agents/${slug}/mounts`)).json()) as { volumeId: string; readOnly: boolean }[]
    const solo = await createAgent('Solo')
    const shared = await createAgent('Shared')
    expect((await page.request.post(`/api/agents/${shared}/access`, { data: { userId: mateId, role: 'user' } })).ok()).toBeTruthy()
    const created = await page.request.post('/api/volume-definitions', { data: { name: `Notes ${stamp}`, type: 'local', config: { path: folder } } })
    expect(created.ok()).toBeTruthy()
    driveId = (await created.json()).id as string

    await page.goto(`/settings/volumes?volume=${driveId}`)
    await page.getByRole('combobox', { name: 'Which of my agents' }).click()
    await page.getByRole('option', { name: 'owned' }).click()
    await page.getByRole('switch', { name: 'Add to all my agents' }).click()
    await expect(page.getByRole('alertdialog')).toContainText('Teammates can read it on Shared.')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('combobox', { name: 'Which of my agents' }).click()
    await page.getByRole('option', { name: 'private' }).click()
    await page.getByRole('switch', { name: 'Add to all my agents' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('on 1 agent?')
    await page.getByTestId('my-agents-confirm').click()

    await expect.poll(async () => (await drives(solo)).find(m => m.volumeId === driveId)?.readOnly).toBe(true)
    expect(await drives(shared)).toEqual([])
    const later = await createAgent('Later')
    expect((await drives(later)).find(m => m.volumeId === driveId)?.readOnly).toBe(true)
  } finally {
    if (driveId) await page.request.delete(`/api/volume-definitions/${driveId}/my-agents`)
    for (const slug of agents) await page.request.delete(`/api/agents/${slug}`)
    if (driveId) await page.request.delete(`/api/volume-definitions/${driveId}`)
    await teammate.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
