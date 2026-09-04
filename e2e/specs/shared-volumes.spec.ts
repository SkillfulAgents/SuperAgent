import { test, expect, type APIRequestContext } from '@playwright/test'
import path from 'node:path'
import { createAgent, deleteAgentViaApi, gotoAgentHome, uniqueName } from '../helpers/agents'
import { mockRecorder } from '../helpers/mock-recorder'

test.describe.configure({ mode: 'serial' })

interface VolumeRow {
  id: string
  name: string
  mountName: string
  attachedAgents: Array<{ slug: string; name: string }>
}

interface StartRecord {
  type: string
  agentSlug?: string
  mounts?: string[]
  mountsEnv?: string | null
}

const recorder = mockRecorder<StartRecord>({ defaultDataDir: path.join(__dirname, '..', '..', '.e2e-data', 'cloud') })

async function listVolumes(request: APIRequestContext) {
  const res = await request.get('/api/volumes')
  expect(res.ok()).toBeTruthy()
  return await res.json() as { volumes: VolumeRow[] }
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

test.describe('shared volumes on a cloud runner', () => {
  test('the mounts route reports shared volumes and not host folders', async ({ request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Flags'))
    const res = await request.get(`/api/agents/${agent.slug}/mounts`)
    expect(res.ok()).toBeTruthy()
    expect(await res.json()).toMatchObject({ hostFolders: false, sharedVolumes: true, mounts: [] })
    const folder = await request.post(`/api/agents/${agent.slug}/mounts`, { data: { hostPath: '/tmp' } })
    expect(folder.status()).toBe(400)
    await deleteAgentViaApi(request, agent)
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

  test('attach, start, and the runtime receives the path and the prompt env', async ({ request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Mounted'))
    const name = uniqueName(testInfo, 'Runtime notes')
    const created = await (await createVolume(request, name)).json() as VolumeRow
    await attachVolume(request, agent.slug, created.id)

    const start = await request.post(`/api/agents/${agent.slug}/start`)
    expect(start.ok(), await start.text()).toBeTruthy()
    const record = await recorder.waitFor(
      (r) => r.type === 'container_start' && r.agentSlug === agent.slug && (r.mounts?.length ?? 0) > 0,
      { label: `container_start with mounts for ${agent.slug}` },
    )
    expect(record.mounts).toEqual([`/volumes/${created.mountName}`])
    expect(record.mountsEnv).toBe(JSON.stringify([`/volumes/${created.mountName}`]))

    await request.post(`/api/agents/${agent.slug}/stop`)
    await request.delete(`/api/agents/${agent.slug}/volumes/${created.id}`)
    await deleteVolume(request, created.id)
    await deleteAgentViaApi(request, agent)
  })

  test('the Volumes card creates, detaches, and re-attaches a shared volume', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Vol Card'))
    await gotoAgentHome(page, agent)
    await expect(page.getByText('Volumes', { exact: true })).toBeVisible()
    await expect(page.getByText('No volumes yet')).toBeVisible()

    const name = uniqueName(testInfo, 'Shared notes')
    await page.getByRole('button', { name: 'Add volume' }).click()
    await expect(page.getByRole('button', { name: 'Add folder from this computer' })).toHaveCount(0)
    await page.getByRole('button', { name: 'New shared volume…' }).click()
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(name)).toBeVisible()
    await expect(page.getByText(/\/volumes\/shared-notes/)).toBeVisible()

    await page.getByRole('button', { name: 'Shared volume actions' }).click()
    await page.getByRole('button', { name: 'Detach shared volume' }).click()
    await page.getByRole('button', { name: 'Detach' }).click()
    await expect(page.getByText('No volumes yet')).toBeVisible()

    const leftover = (await listVolumes(request)).volumes.find((volume) => volume.name === name)
    expect(leftover).toBeTruthy()
    expect(leftover?.attachedAgents).toEqual([])

    await page.getByRole('button', { name: 'Add volume' }).click()
    await page.getByRole('button', { name: `${name} No agents attached` }).click()
    await expect(page.getByText(`/volumes/${leftover!.mountName}`)).toBeVisible()

    await deleteVolume(request, leftover!.id)
    await deleteAgentViaApi(request, agent)
  })
})
