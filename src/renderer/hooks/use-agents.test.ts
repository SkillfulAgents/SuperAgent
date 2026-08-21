import { describe, it, expect } from 'vitest'
import type { ApiAgent } from '@shared/lib/types/api'
import { resolveRouteAgentId } from './use-agents'

// Minimal agent factory — only the id/displaySlug fields the resolver reads.
function agent(slug: string, displaySlug: string): ApiAgent {
  return { slug, displaySlug, name: displaySlug, createdAt: new Date(), status: 'stopped', containerPort: null }
}

describe('resolveRouteAgentId', () => {
  const ID = 'abcd123456' // 10-char minted id
  const renamed = agent(ID, `greeting-assistant-${ID}`)

  it('resolves the bare id', () => {
    expect(resolveRouteAgentId(ID, [renamed])).toBe(ID)
  })

  it('resolves the current display slug', () => {
    expect(resolveRouteAgentId(`greeting-assistant-${ID}`, [renamed])).toBe(ID)
  })

  it('resolves a STALE display slug after an auto-rename (the deselect bug)', () => {
    // URL still says untitled-{id} from creation; agent is now greeting-assistant-{id}.
    expect(resolveRouteAgentId(`untitled-${ID}`, [renamed])).toBe(ID)
  })

  it('resolves a wrong-prefix slug (prefix is decorative)', () => {
    expect(resolveRouteAgentId(`literally-anything-${ID}`, [renamed])).toBe(ID)
  })

  it('resolves a legacy compound folder id exactly', () => {
    const legacy = agent('untitled-h45k3n', 'untitled-h45k3n')
    expect(resolveRouteAgentId('untitled-h45k3n', [legacy])).toBe('untitled-h45k3n')
  })

  it('picks the right agent when several are loaded', () => {
    const other = agent('zzzz999999', 'other-zzzz999999')
    expect(resolveRouteAgentId(`untitled-${ID}`, [other, renamed])).toBe(ID)
  })

  it('falls back to the raw slug when nothing matches', () => {
    expect(resolveRouteAgentId('unknown-9999999999', [renamed])).toBe('unknown-9999999999')
  })

  it('falls back to the raw slug while the agents list is still loading', () => {
    expect(resolveRouteAgentId(`untitled-${ID}`, undefined)).toBe(`untitled-${ID}`)
  })

  it('returns undefined for no slug', () => {
    expect(resolveRouteAgentId(undefined, [renamed])).toBeUndefined()
  })
})
