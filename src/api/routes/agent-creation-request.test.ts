// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ApiAgent } from '@shared/lib/types/api'
import { createAgentOnce } from './agent-creation-request'

describe('resuming an agent creation request', () => {
  const agent = { slug: 'scout' } as ApiAgent

  it('allows one create per user and request, including while the first create is still running', async () => {
    let finish!: (agent: ApiAgent) => void
    const create = vi.fn(() => new Promise<ApiAgent>(resolve => { finish = resolve }))
    const original = createAgentOnce('alice', 'setup', create)
    await expect(createAgentOnce('alice', 'setup', create)).resolves.toEqual({ existingSlug: null })
    finish(agent)
    await expect(original).resolves.toEqual({ created: agent })
    await expect(createAgentOnce('alice', 'setup', create)).resolves.toEqual({ existingSlug: agent.slug })
    expect(create).toHaveBeenCalledTimes(1)
    await expect(createAgentOnce('bob', 'setup', async () => agent)).resolves.toEqual({ created: agent })
  })

  it('can retry when creation fails', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('workspace unavailable')).mockResolvedValueOnce(agent)
    await expect(createAgentOnce('alice', 'setup', create)).rejects.toThrow('workspace unavailable')
    await expect(createAgentOnce('alice', 'setup', create)).resolves.toEqual({ created: agent })
  })
})
