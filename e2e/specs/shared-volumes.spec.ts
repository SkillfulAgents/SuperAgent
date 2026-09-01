import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createAgent, deleteAgentViaApi, gotoAgentHome, uniqueName } from '../helpers/agents'

test.describe.configure({ mode: 'serial' })

interface VolumeRow {
  id: string
  name: string
  mountName: string
  attachedAgents: Array<{ slug: string; name: string }>
}

async function listVolumes(request: APIRequestContext) {
  const res = await request.get('/api/volumes')
  expect(res.ok()).toBeTruthy()
  return await res.json() as { supported: boolean; volumes: VolumeRow[] }
}

async function createVolume(request: APIRequestContext, name: string, expected = 201) {
  const res = await request.post('/api/volumes', { data: { name } })
  expect(res.status(), await res.text()).toBe(expected)
  return res
}

async function attachVolume(request: APIRequestContext, agentSlug: string, volumeId: string, expected = 201) {
  const res = await request.post(`/api/agents/${agentSlug}/volumes`, { data: { volumeId } })
  expect(res.status(), await res.text()).toBe(expected)
  return res
}

async function deleteVolume(request: APIRequestContext, volumeId: string, expected = 200) {
  const res = await request.delete(`/api/volumes/${volumeId}`)
  expect(res.status(), await res.text()).toBe(expected)
  return res
}

/**
 * The Shared Volumes card is gated on GET /api/volumes.supported, which follows
 * the process-wide container runner. Settings refuse a runner change while any
 * agent is running, so a parallel e2e suite cannot flip it. Rewrite this page's
 * registry reads only; create/attach/detach still hit the real API.
 */
async function showSharedVolumesCard(page: Page) {
  await page.route('**/api/volumes', async (route) => {
    const path = route.request().url().split('?')[0]
    if (route.request().method() !== 'GET' || !path.endsWith('/api/volumes')) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const body = await response.json() as { supported: boolean; volumes: VolumeRow[] }
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify({ ...body, supported: true }),
    })
  })
}

test.describe('shared volumes', () => {
  test('default runner reports unsupported', async ({ request }) => {
    const body = await listVolumes(request)
    expect(body.supported).toBe(false)
  })

  test('reserved prompt env is rejected at settings write', async ({ request }) => {
    const res = await request.put('/api/settings', {
      data: { customEnvVars: { SUPERAGENT_SHARED_VOLUMES: '/volumes/fake' } },
    })
    expect(res.status()).toBe(400)
    expect(await res.text()).toContain('SUPERAGENT_SHARED_VOLUMES')
  })

  test('create, attach, refuse delete while shared, detach, delete', async ({ request }, testInfo) => {
    const agentA = await createAgent(request, uniqueName(testInfo, 'Vol A'))
    const agentB = await createAgent(request, uniqueName(testInfo, 'Vol B'))
    const name = uniqueName(testInfo, 'Team notes')

    const created = await (await createVolume(request, name)).json() as VolumeRow
    expect(created.mountName).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/)

    const empty = await createVolume(request, '', 400)
    expect(empty.status()).toBe(400)
    const dup = await createVolume(request, name, 400)
    expect(dup.status()).toBe(400)

    await attachVolume(request, agentA.slug, created.id)
    await attachVolume(request, agentA.slug, created.id, 409)
    await attachVolume(request, agentB.slug, created.id)

    const listed = await listVolumes(request)
    const row = listed.volumes.find((volume) => volume.id === created.id)
    expect(row?.attachedAgents.map((agent) => agent.slug).sort()).toEqual(
      [agentA.slug, agentB.slug].sort(),
    )

    await deleteVolume(request, created.id, 409)

    const detachA = await request.delete(`/api/agents/${agentA.slug}/volumes/${created.id}`)
    expect(detachA.status()).toBe(200)
    const missingDetach = await request.delete(`/api/agents/${agentA.slug}/volumes/${created.id}`)
    expect(missingDetach.status()).toBe(200)

    const afterDetach = await listVolumes(request)
    expect(afterDetach.volumes.find((volume) => volume.id === created.id)?.attachedAgents).toEqual([
      expect.objectContaining({ slug: agentB.slug }),
    ])

    await deleteAgentViaApi(request, agentB)
    const afterAgentDelete = await listVolumes(request)
    expect(afterAgentDelete.volumes.some((volume) => volume.id === created.id)).toBe(true)
    expect(afterAgentDelete.volumes.find((volume) => volume.id === created.id)?.attachedAgents).toEqual([])

    await deleteVolume(request, created.id)
    const gone = await listVolumes(request)
    expect(gone.volumes.some((volume) => volume.id === created.id)).toBe(false)

    await deleteAgentViaApi(request, agentA)
  })

  test('shared-volumes card create and detach', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Vol Card'))
    await showSharedVolumesCard(page)

    await gotoAgentHome(page, agent)
    await expect(page.getByText('Shared Volumes', { exact: true })).toBeVisible()
    await expect(page.getByText('No shared volumes yet')).toBeVisible()
    await expect(page.getByText('Volumes', { exact: true })).toHaveCount(0)

    const name = uniqueName(testInfo, 'Shared notes')
    await page.getByRole('button', { name: 'Add shared volume' }).click()
    await page.getByRole('button', { name: 'New shared volume…' }).click()
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(name)).toBeVisible()
    await expect(page.getByText(/\/volumes\/shared-notes/)).toBeVisible()

    await page.getByRole('button', { name: 'Shared volume actions' }).click()
    await page.getByRole('button', { name: 'Detach shared volume' }).click()
    await page.getByRole('button', { name: 'Detach' }).click()
    await expect(page.getByText('No shared volumes yet')).toBeVisible()

    const leftover = (await listVolumes(request)).volumes.find((volume) => volume.name === name)
    expect(leftover).toBeTruthy()
    expect(leftover?.attachedAgents).toEqual([])

    await page.getByRole('button', { name: 'Add shared volume' }).click()
    await page.getByRole('button', { name: `${name} No agents attached` }).click()
    await expect(page.getByText(`/volumes/${leftover!.mountName}`)).toBeVisible()

    await deleteVolume(request, leftover!.id)
    await deleteAgentViaApi(request, agent)
  })
})
