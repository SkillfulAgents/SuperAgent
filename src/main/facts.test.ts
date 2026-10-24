import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerFacts } from '@shared/lib/facts/server-facts'
import { _resetCloudFactsForTest, factsForRenderer } from './facts'

/**
 * What main tells each renderer at boot: this install as the client, and the
 * server it drives, which for a cloud workspace only the deployment knows.
 */

const CLOUD = { baseUrl: 'http://localhost:3000/cloud/KEY', deploymentUrl: 'https://acme.example' }
const OTHER_CLOUD = { baseUrl: 'http://localhost:3000/cloud/KEY', deploymentUrl: 'https://other.example' }
const DEPLOYMENT_FACTS = { os: 'linux', distribution: 'deployment' }

const fetchMock = vi.fn<typeof fetch>()

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  _resetCloudFactsForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('describes this install on both sides for the local API, which main hosts', async () => {
  const facts = await factsForRenderer('local', CLOUD)

  expect(facts.client.shell).toBe('electron')
  expect(facts.server).toEqual(getServerFacts())
  expect(fetchMock).not.toHaveBeenCalled()
})

describe('for a cloud workspace', () => {
  it('asks the deployment through the cloud proxy, which holds the credential', async () => {
    fetchMock.mockResolvedValue(answer(DEPLOYMENT_FACTS))
    const facts = await factsForRenderer('cloud', CLOUD)

    expect(facts.server).toEqual(DEPLOYMENT_FACTS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${CLOUD.baseUrl}/api/server-facts`)
    // Boot waits on it, so it has to give up.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('asks once per deployment, however many windows boot', async () => {
    fetchMock.mockImplementation(async () => answer(DEPLOYMENT_FACTS))
    await Promise.all([factsForRenderer('cloud', CLOUD), factsForRenderer('cloud', CLOUD)])
    await factsForRenderer('cloud', CLOUD)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await factsForRenderer('cloud', OTHER_CLOUD)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['answers 404, as one older than the endpoint does', async () => answer({ error: 'Not found' }, 404)],
    ['sends facts it can’t read', async () => answer({ os: 'linux' })],
    ['can’t be reached', async () => Promise.reject(new TypeError('fetch failed'))],
  ])('has no server facts when the deployment %s, and asks again next boot', async (_, respond) => {
    fetchMock.mockImplementationOnce(respond)
    expect((await factsForRenderer('cloud', CLOUD)).server).toBeNull()

    fetchMock.mockResolvedValueOnce(answer(DEPLOYMENT_FACTS))
    expect((await factsForRenderer('cloud', CLOUD)).server).toEqual(DEPLOYMENT_FACTS)
  })

  it('has no server facts when there is no workspace to ask', async () => {
    const facts = await factsForRenderer('cloud', null)

    expect(facts.server).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
