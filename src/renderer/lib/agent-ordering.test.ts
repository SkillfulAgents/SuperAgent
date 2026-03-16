import { describe, it, expect } from 'vitest'
import { applyAgentOrder } from './agent-ordering'
import type { ApiAgent } from '@renderer/hooks/use-agents'

function makeAgent(slug: string, createdAt: string): ApiAgent {
  return {
    slug,
    name: slug,
    createdAt: new Date(createdAt),
    status: 'stopped',
    containerPort: null,
  }
}

describe('applyAgentOrder', () => {
  const agentA = makeAgent('a', '2025-01-01')
  const agentB = makeAgent('b', '2025-02-01')
  const agentC = makeAgent('c', '2025-03-01')

  it('returns agents as-is when no saved order', () => {
    const result = applyAgentOrder([agentA, agentB, agentC], undefined)
    expect(result).toEqual([agentA, agentB, agentC])
  })

  it('returns agents as-is when saved order is empty', () => {
    const result = applyAgentOrder([agentA, agentB, agentC], [])
    expect(result).toEqual([agentA, agentB, agentC])
  })

  it('reorders agents according to saved order', () => {
    const result = applyAgentOrder([agentA, agentB, agentC], ['c', 'a', 'b'])
    expect(result.map(a => a.slug)).toEqual(['c', 'a', 'b'])
  })

  it('places new agents at top sorted by createdAt desc', () => {
    const result = applyAgentOrder([agentA, agentB, agentC], ['a'])
    // B and C are new (not in order), sorted by createdAt desc → C, B, then A
    expect(result.map(a => a.slug)).toEqual(['c', 'b', 'a'])
  })

  it('silently ignores deleted agents in saved order', () => {
    const result = applyAgentOrder([agentA, agentC], ['c', 'deleted', 'a'])
    expect(result.map(a => a.slug)).toEqual(['c', 'a'])
  })

  it('handles empty agents list', () => {
    const result = applyAgentOrder([], ['a', 'b'])
    expect(result).toEqual([])
  })

  it('handles all agents being new', () => {
    const result = applyAgentOrder([agentA, agentB, agentC], ['x', 'y'])
    // All new, sorted by createdAt desc
    expect(result.map(a => a.slug)).toEqual(['c', 'b', 'a'])
  })
})
