import { describe, expect, it } from 'vitest'
import type { AgentActor } from '@shared/lib/agent-actor/types'
import type { CloudflareAgentActor } from './cloudflare-agent-actor'
import { ownedHere, runAsAgentObject, servingAgentObject } from './agent-objects'

const actor = (where: string) => ({ slug: 'sales-agent', files: { getDoc: async () => where } }) as unknown as AgentActor
const object = {} as CloudflareAgentActor

describe('ownedHere', () => {
  it("uses the actor in this isolate only inside the agent's own object, and the remote one everywhere else", async () => {
    const reached = ownedHere('sales-agent', actor('local'), actor('remote'))

    expect(await reached.files.getDoc('AGENTS.md')).toBe('remote')
    expect(await runAsAgentObject('sales-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('local')
    expect(await runAsAgentObject('support-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('remote')
  })

  it("keeps the agent's object for work its request starts later", async () => {
    const later = runAsAgentObject('sales-agent', object, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return servingAgentObject('sales-agent')
    })
    expect(await later).toBe(object)
    expect(servingAgentObject('sales-agent')).toBeNull()
  })
})
