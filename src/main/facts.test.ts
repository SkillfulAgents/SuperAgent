import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerFacts } from '@shared/lib/facts/server-facts'
import { factsForRenderer } from './facts'

/**
 * What main tells each renderer at boot: this install as the client, and the
 * server it drives. Every boot waits on it, so it never asks the network.
 */

const known = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@shared/lib/services/cloud-server-facts', () => ({
  readCloudServerFacts: (deploymentUrl: string) => known.get(deploymentUrl) ?? null,
}))

const CLOUD = { baseUrl: 'http://localhost:3000/cloud/KEY', deploymentUrl: 'https://acme.example' }
const DEPLOYMENT_FACTS = { os: 'linux', distribution: 'deployment' }

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  known.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('describes this install on both sides for the local API, which main hosts', () => {
  const facts = factsForRenderer('local', CLOUD)

  expect(facts.client.shell).toBe('electron')
  expect(facts.server).toEqual(getServerFacts())
})

describe('for a cloud workspace', () => {
  it('answers from what main last heard from the deployment, without asking it', () => {
    known.set(CLOUD.deploymentUrl, DEPLOYMENT_FACTS)

    expect(factsForRenderer('cloud', CLOUD).server).toEqual(DEPLOYMENT_FACTS)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has no server facts for a deployment main hasn’t heard from yet', () => {
    expect(factsForRenderer('cloud', CLOUD).server).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has no server facts when there is no workspace', () => {
    known.set(CLOUD.deploymentUrl, DEPLOYMENT_FACTS)
    expect(factsForRenderer('cloud', null).server).toBeNull()
  })
})
