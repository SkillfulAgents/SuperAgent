/**
 * A renderer driving a cloud workspace reads the deployment's facts at boot, and
 * boot must not wait on the network for them. So the workspace's maintenance
 * cycle fetches them in the background and keeps the last answer in settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readCloudServerFacts, refreshCloudServerFacts } from './cloud-server-facts'

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, writes: 0 }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => state.settings,
  mutateSettings: (mutator: (settings: Record<string, unknown>) => void) => {
    state.writes += 1
    mutator(state.settings)
    return state.settings
  },
}))

const DEPLOYMENT = 'https://acme.example'
const FACTS = { os: 'linux', distribution: 'deployment' }

const fetchMock = vi.fn<typeof fetch>()

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  state.settings = {}
  state.writes = 0
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshCloudServerFacts', () => {
  it('asks the deployment, without its credential, and keeps the answer', async () => {
    fetchMock.mockResolvedValue(answer(FACTS))
    await refreshCloudServerFacts(`${DEPLOYMENT}/`)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${DEPLOYMENT}/api/server-facts`)
    expect(init?.headers).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(readCloudServerFacts(DEPLOYMENT)).toEqual(FACTS)
  })

  it('writes settings only when the answer changed', async () => {
    fetchMock.mockImplementation(async () => answer(FACTS))
    await refreshCloudServerFacts(DEPLOYMENT)
    await refreshCloudServerFacts(DEPLOYMENT)
    expect(state.writes).toBe(1)

    fetchMock.mockImplementation(async () => answer({ ...FACTS, os: 'win32' }))
    await refreshCloudServerFacts(DEPLOYMENT)
    expect(state.writes).toBe(2)
    expect(readCloudServerFacts(DEPLOYMENT)?.os).toBe('win32')
  })

  it.each([
    ['answers 404, as one older than the endpoint does', async () => answer({ error: 'Not found' }, 404)],
    ['sends facts it can’t read', async () => answer({ os: 'linux' })],
    ['can’t be reached', async () => Promise.reject(new TypeError('fetch failed'))],
  ])('keeps the last answer when the deployment %s', async (_, respond) => {
    fetchMock.mockResolvedValueOnce(answer(FACTS))
    await refreshCloudServerFacts(DEPLOYMENT)

    fetchMock.mockImplementationOnce(respond)
    await expect(refreshCloudServerFacts(DEPLOYMENT)).resolves.toBeUndefined()
    expect(readCloudServerFacts(DEPLOYMENT)).toEqual(FACTS)
  })
})

describe('readCloudServerFacts', () => {
  it('has nothing for a deployment it never heard from', () => {
    expect(readCloudServerFacts(DEPLOYMENT)).toBeNull()
  })

  it('answers only for the deployment the facts came from', async () => {
    fetchMock.mockResolvedValue(answer(FACTS))
    await refreshCloudServerFacts(DEPLOYMENT)

    expect(readCloudServerFacts(`${DEPLOYMENT}/`)).toEqual(FACTS)
    expect(readCloudServerFacts('https://other.example')).toBeNull()
  })

  it('reads a corrupt record as nothing', () => {
    state.settings.cloudServerFacts = { deploymentUrl: DEPLOYMENT, facts: { os: 'beos' } }
    expect(readCloudServerFacts(DEPLOYMENT)).toBeNull()
  })
})
