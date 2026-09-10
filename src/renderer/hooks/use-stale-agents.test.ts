import { describe, it, expect } from 'vitest'
import type { ApiAgent } from '@shared/lib/types/api'
import { describeStaleAgents } from './use-stale-agents'

function agent(slug: string, name: string, hasActiveSessions?: boolean): ApiAgent {
  return { slug, displaySlug: slug, name, createdAt: new Date(), status: 'running', containerPort: 4000, hasActiveSessions }
}

describe('describeStaleAgents', () => {
  it('joins names and the working marker from the live agent list, keeping host order', () => {
    const rows = describeStaleAgents(
      [{ slug: 'b', status: 'pending' }, { slug: 'a', status: 'failed', error: 'boom' }],
      [agent('a', 'Research assistant'), agent('b', 'Shopify ops', true)],
    )
    expect(rows).toEqual([
      { slug: 'b', status: 'pending', name: 'Shopify ops', working: true },
      { slug: 'a', status: 'failed', error: 'boom', name: 'Research assistant', working: false },
    ])
  })

  it('falls back to the slug for an agent the list does not carry', () => {
    expect(describeStaleAgents([{ slug: 'gone', status: 'pending' }], [])).toEqual([
      { slug: 'gone', status: 'pending', name: 'gone', working: false },
    ])
  })
})
