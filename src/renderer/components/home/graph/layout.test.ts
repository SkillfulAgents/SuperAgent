import { describe, it, expect } from 'vitest'
import { computeLayout } from './layout'
import type { GraphEdgeSpec, GraphNodeSpec } from './use-graph-data'

const agentNode = (slug: string): GraphNodeSpec =>
  ({ id: `agent:${slug}`, data: { kind: 'agent', agent: { slug } } }) as unknown as GraphNodeSpec

const accountNode = (id: string): GraphNodeSpec =>
  ({ id: `account:${id}`, data: { kind: 'account', resourceId: id } }) as unknown as GraphNodeSpec

const resourceEdge = (agentSlug: string, accountId: string): GraphEdgeSpec => ({
  id: `agent:${agentSlug}->account:${accountId}`,
  source: `agent:${agentSlug}`,
  target: `account:${accountId}`,
  variant: 'resource',
})

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

describe('computeLayout', () => {
  it('returns an empty map for empty input', () => {
    expect(computeLayout([], [])).toEqual({})
  })

  it('positions every node and rounds to integers', () => {
    const nodes = [agentNode('a'), agentNode('b'), accountNode('acc'), agentNode('bare')]
    const edges = [resourceEdge('a', 'acc'), resourceEdge('b', 'acc')]
    const positions = computeLayout(nodes, edges)
    expect(Object.keys(positions).sort()).toEqual(nodes.map((n) => n.id).sort())
    for (const p of Object.values(positions)) {
      expect(Number.isInteger(p.x)).toBe(true)
      expect(Number.isInteger(p.y)).toBe(true)
    }
  })

  it('is deterministic: identical inputs produce identical positions', () => {
    const nodes = [agentNode('a'), agentNode('b'), agentNode('c'), accountNode('x'), accountNode('y')]
    const edges = [resourceEdge('a', 'x'), resourceEdge('b', 'x'), resourceEdge('c', 'y')]
    expect(computeLayout(nodes, edges)).toEqual(computeLayout(nodes, edges))
  })

  it('is independent of node input order (inputs are sorted internally)', () => {
    const nodes = [agentNode('a'), agentNode('b'), accountNode('x'), agentNode('bare')]
    const edges = [resourceEdge('a', 'x'), resourceEdge('b', 'x')]
    const forward = computeLayout(nodes, edges)
    const reversed = computeLayout([...nodes].reverse(), edges)
    expect(reversed).toEqual(forward)
  })

  it('keeps force-laid nodes apart at least by their collision footprint', () => {
    // Two agents sharing an account: springs pull them together, collision
    // must keep the rendered cards (~176×80) from overlapping.
    const nodes = [agentNode('a'), agentNode('b'), accountNode('shared')]
    const edges = [resourceEdge('a', 'shared'), resourceEdge('b', 'shared')]
    const positions = computeLayout(nodes, edges)
    expect(distance(positions['agent:a'], positions['agent:b'])).toBeGreaterThanOrEqual(200)
    expect(distance(positions['agent:a'], positions['account:shared'])).toBeGreaterThanOrEqual(150)
    expect(distance(positions['agent:b'], positions['account:shared'])).toBeGreaterThanOrEqual(150)
  })

  it('bands the graph: connected cloud above bare-agent grid above orphan grid', () => {
    const nodes = [
      agentNode('linked'),
      accountNode('acc'),
      agentNode('bare1'),
      agentNode('bare2'),
      accountNode('orphan'),
    ]
    const edges = [resourceEdge('linked', 'acc')]
    const positions = computeLayout(nodes, edges)

    const forceBottom = Math.max(positions['agent:linked'].y, positions['account:acc'].y)
    expect(positions['agent:bare1'].y).toBeGreaterThan(forceBottom)
    expect(positions['agent:bare2'].y).toBeGreaterThan(forceBottom)
    expect(positions['account:orphan'].y).toBeGreaterThan(
      Math.max(positions['agent:bare1'].y, positions['agent:bare2'].y),
    )
  })

  it('packs disconnected bands into sorted fixed-cell grids from the origin', () => {
    // No connected subgraph at all: the bare-agent grid starts at y=0.
    const nodes = [agentNode('b'), agentNode('a'), accountNode('z-orphan')]
    const positions = computeLayout(nodes, [])
    expect(positions['agent:a']).toEqual({ x: 0, y: 0 })
    // Sorted by id, second agent sits one 250px cell to the right.
    expect(positions['agent:b']).toEqual({ x: 250, y: 0 })
    // Orphan resources form their own band below, back at x=0.
    expect(positions['account:z-orphan'].x).toBe(0)
    expect(positions['account:z-orphan'].y).toBeGreaterThan(0)
  })

  it('agents joined only by permission/activity edges count as connected, not bare', () => {
    const nodes = [agentNode('caller'), agentNode('target'), agentNode('bare')]
    const edges: GraphEdgeSpec[] = [
      {
        id: 'agent:caller~agent:target',
        source: 'agent:caller',
        target: 'agent:target',
        variant: 'permission',
      },
    ]
    const positions = computeLayout(nodes, edges)
    // The pair lands in the force band; the bare agent starts a grid below it.
    const forceBottom = Math.max(positions['agent:caller'].y, positions['agent:target'].y)
    expect(positions['agent:bare'].y).toBeGreaterThan(forceBottom)
    // Related agents sit a spring-length apart, not stacked and not flung away.
    const d = distance(positions['agent:caller'], positions['agent:target'])
    expect(d).toBeGreaterThanOrEqual(200)
    expect(d).toBeLessThanOrEqual(900)
  })
})
