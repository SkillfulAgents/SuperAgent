import { beforeEach, describe, expect, it, vi } from 'vitest'

const fromUserId = vi.fn()
const forAgent = vi.fn()
const requiresActingMember = vi.fn(async (_settings?: unknown) => true)
vi.mock('../../platform-attribution', () => ({
  attribution: {
    fromUserId: (id: string, settings?: unknown) => fromUserId(id, settings),
    forAgent: (slug: string, settings?: unknown) => forAgent(slug, settings),
    requiresActingMember: (settings?: unknown) => requiresActingMember(settings),
  },
}))
vi.mock('../../services/platform-auth-service', () => ({
  getPlatformAccessToken: async () => 'org-token',
  platformAccessTokenFrom: () => 'org-token',
}))
/** Settings reads: each hands back a distinct snapshot. */
const getSettings = vi.fn(async () => ({ read: getSettings.mock.calls.length }))
vi.mock('../../config/settings', () => ({ getSettings: () => getSettings() }))
vi.mock('../../platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.example' }))

import { resolveRecallTransport } from './transport'

const member = (id: string) => ({ bearerToken: () => `org-token::${id}` })

describe('platform Recall transport', () => {
  beforeEach(() => {
    delete process.env.RECALL_API_KEY
    fromUserId.mockReset()
    forAgent.mockReset()
    getSettings.mockClear()
  })

  it('bills the person who set up the meetings integration', async () => {
    fromUserId.mockResolvedValue(member('mem_alice'))
    const transport = (await resolveRecallTransport())!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: 'alice' })).resolves.toBe('Bearer org-token::mem_alice')
    expect(forAgent).not.toHaveBeenCalled()
  })

  it('builds each call\'s authorization from one settings read', async () => {
    forAgent.mockResolvedValue(null)
    requiresActingMember.mockResolvedValueOnce(false)
    const transport = (await resolveRecallTransport())!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: null })).resolves.toBe('Bearer org-token')
    expect(getSettings).toHaveBeenCalledOnce()
    const snapshot = await getSettings.mock.results[0].value
    expect(forAgent).toHaveBeenCalledWith('helper', snapshot)
    expect(requiresActingMember).toHaveBeenCalledWith(snapshot)
  })

  it('bills the agent owner when the agent set up its own meetings', async () => {
    forAgent.mockResolvedValue(member('mem_owner'))
    const transport = (await resolveRecallTransport())!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: null })).resolves.toBe('Bearer org-token::mem_owner')
    expect(forAgent).toHaveBeenCalledWith('helper', expect.anything())
  })

  it('refuses an org token when nobody can be billed', async () => {
    forAgent.mockResolvedValue(null)
    const transport = (await resolveRecallTransport())!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: null })).rejects.toThrow(/member identity/)
  })
})
