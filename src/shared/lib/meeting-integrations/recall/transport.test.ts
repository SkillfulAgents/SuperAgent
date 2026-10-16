import { beforeEach, describe, expect, it, vi } from 'vitest'

const fromUserId = vi.fn()
const forAgent = vi.fn()
vi.mock('../../platform-attribution', () => ({
  attribution: { fromUserId: (id: string) => fromUserId(id), forAgent: (slug: string) => forAgent(slug), requiresActingMember: () => true },
}))
vi.mock('../../services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'org-token' }))
vi.mock('../../platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.example' }))

import { resolveRecallTransport } from './transport'

const member = (id: string) => ({ bearerToken: () => `org-token::${id}` })

describe('platform Recall transport', () => {
  beforeEach(() => {
    delete process.env.RECALL_API_KEY
    fromUserId.mockReset()
    forAgent.mockReset()
  })

  it('bills the person who set up the meetings integration', async () => {
    fromUserId.mockResolvedValue(member('mem_alice'))
    const transport = resolveRecallTransport()!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: 'alice' })).resolves.toBe('Bearer org-token::mem_alice')
    expect(forAgent).not.toHaveBeenCalled()
  })

  it('bills the agent owner when the agent set up its own meetings', async () => {
    forAgent.mockResolvedValue(member('mem_owner'))
    const transport = resolveRecallTransport()!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: null })).resolves.toBe('Bearer org-token::mem_owner')
    expect(forAgent).toHaveBeenCalledWith('helper')
  })

  it('refuses an org token when nobody can be billed', async () => {
    forAgent.mockResolvedValue(null)
    const transport = resolveRecallTransport()!
    await expect(transport.authorization({ agentSlug: 'helper', createdByUserId: null })).rejects.toThrow(/member identity/)
  })
})
