import { describe, it, expect } from 'vitest'
import { buildGraph, nodeId } from './use-graph-data'
import type { ApiAgent } from '@shared/lib/types/api'
import type { ConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import type { HomeGraphData } from '@shared/lib/types/home-graph-schema'

const agent = (slug: string): ApiAgent =>
  ({ slug, displaySlug: slug, name: slug, status: 'stopped' }) as unknown as ApiAgent

const account = (id: string, status: ConnectedAccount['status'] = 'active'): ConnectedAccount =>
  ({ id, toolkitSlug: 'gmail', displayName: id, status }) as unknown as ConnectedAccount

const mcp = (id: string): RemoteMcpServer =>
  ({ id, name: id, status: 'active' }) as unknown as RemoteMcpServer

const emptyTopology: HomeGraphData = {
  accountLinks: [],
  mcpLinks: [],
  chats: [],
  webhooks: [],
  crons: [],
  permissions: [],
  invocations: [],
  accountUsage: {},
  mcpUsage: {},
}

describe('buildGraph', () => {
  it('renders nodes without edges while the topology is still loading', () => {
    const graph = buildGraph({ agents: [agent('a')], accounts: [account('acc')], mcps: [], topology: undefined })
    expect(graph.nodes.map((n) => n.id)).toEqual([nodeId.agent('a'), nodeId.account('acc')])
    expect(graph.edges).toEqual([])
  })

  it('weights exercised links and leaves unexercised ones weightless (rendered dashed)', () => {
    const graph = buildGraph({
      agents: [agent('a')],
      accounts: [account('used'), account('unused')],
      mcps: [],
      topology: {
        ...emptyTopology,
        accountLinks: [
          { agentSlug: 'a', accountId: 'used' },
          { agentSlug: 'a', accountId: 'unused' },
        ],
        accountUsage: { 'a:used': 40 },
      },
    })
    const used = graph.edges.find((e) => e.target === nodeId.account('used'))
    const unused = graph.edges.find((e) => e.target === nodeId.account('unused'))
    expect(used).toMatchObject({ variant: 'resource', weight: 40 })
    expect(unused?.weight).toBeUndefined()
  })

  it('drops links whose endpoints are unknown (deleted agent, other user’s account)', () => {
    const graph = buildGraph({
      agents: [agent('a')],
      accounts: [account('acc')],
      mcps: [mcp('m')],
      topology: {
        ...emptyTopology,
        accountLinks: [
          { agentSlug: 'ghost', accountId: 'acc' },
          { agentSlug: 'a', accountId: 'foreign' },
        ],
        mcpLinks: [{ agentSlug: 'a', mcpId: 'm' }],
      },
    })
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ source: nodeId.agent('a'), target: nodeId.mcp('m') })
  })

  it('creates trigger nodes owned by their agent, with fire/execution/session weights', () => {
    const graph = buildGraph({
      agents: [agent('a')],
      accounts: [],
      mcps: [],
      topology: {
        ...emptyTopology,
        chats: [{ id: 'c1', agentSlug: 'a', provider: 'telegram', name: null, status: 'active', connected: true, sessionCount: 2 }],
        webhooks: [{ id: 'w1', agentSlug: 'a', triggerType: 'T', name: null, status: 'active', fireCount: 0 }],
        crons: [{ id: 'k1', agentSlug: 'a', name: null, scheduleExpression: '* * * * *', isRecurring: true, status: 'pending', executionCount: 7 }],
      },
    })
    const byId = new Map(graph.edges.map((e) => [e.target, e]))
    expect(byId.get(nodeId.chat('c1'))).toMatchObject({ variant: 'trigger', weight: 2 })
    expect(byId.get(nodeId.webhook('w1'))).toMatchObject({ variant: 'trigger', weight: 0 })
    expect(byId.get(nodeId.cron('k1'))).toMatchObject({ variant: 'trigger', weight: 7 })
    expect(graph.nodes.filter((n) => n.data.kind !== 'agent')).toHaveLength(3)
  })

  it('merges bidirectional invocations into one activity edge with summed weight', () => {
    const graph = buildGraph({
      agents: [agent('a'), agent('b')],
      accounts: [],
      mcps: [],
      topology: {
        ...emptyTopology,
        invocations: [
          { caller: 'a', target: 'b', count: 3 },
          { caller: 'b', target: 'a', count: 2 },
        ],
      },
    })
    const activity = graph.edges.filter((e) => e.variant === 'activity')
    expect(activity).toHaveLength(1)
    expect(activity[0].weight).toBe(5)
  })

  it('suppresses the permission edge when the pair has activity in EITHER direction', () => {
    const graph = buildGraph({
      agents: [agent('a'), agent('b'), agent('c')],
      accounts: [],
      mcps: [],
      topology: {
        ...emptyTopology,
        // b→a activity must hide the a→b permission line: both render as the
        // same undirected straight segment.
        invocations: [{ caller: 'b', target: 'a', count: 1 }],
        permissions: [
          { caller: 'a', target: 'b' },
          { caller: 'a', target: 'c' },
          { caller: 'c', target: 'a' }, // same pair as above — deduped
        ],
      },
    })
    const permissions = graph.edges.filter((e) => e.variant === 'permission')
    expect(permissions).toHaveLength(1)
    const pair = [permissions[0].source, permissions[0].target].sort()
    expect(pair).toEqual([nodeId.agent('a'), nodeId.agent('c')])
  })

  it('gates edge affordances on the caller role instead of rendering dead controls', () => {
    // The user owns 'mine', has user role on 'shared', viewer on 'theirs'.
    const roles = {
      canUse: (slug: string) => slug === 'mine' || slug === 'shared',
      canAdmin: (slug: string) => slug === 'mine',
    }
    const graph = buildGraph({
      agents: [agent('mine'), agent('shared'), agent('theirs')],
      accounts: [account('acc')],
      mcps: [],
      roles,
      topology: {
        ...emptyTopology,
        accountLinks: [
          { agentSlug: 'shared', accountId: 'acc' },
          { agentSlug: 'theirs', accountId: 'acc' },
        ],
        permissions: [
          { caller: 'mine', target: 'shared' },
          { caller: 'shared', target: 'mine' },
          { caller: 'theirs', target: 'shared' },
        ],
      },
    })
    // Unlinking own account needs user role on the agent side.
    const sharedLink = graph.edges.find((e) => e.source === nodeId.agent('shared') && e.variant === 'resource')
    const theirsLink = graph.edges.find((e) => e.source === nodeId.agent('theirs') && e.variant === 'resource')
    expect(sharedLink?.deletable).toBe(true)
    expect(theirsLink?.deletable).toBe(false)
    // Mixed-role pair: only the direction whose caller the user owns is
    // editable — delete must attempt exactly that direction, and the edit
    // target must be an agent whose settings the user can actually open.
    const mixed = graph.edges.find((e) => e.id.includes('mine') && e.variant === 'permission')
    expect(mixed).toMatchObject({ deletable: true, policyAgentSlug: 'mine', policyCallers: ['mine'] })
    // A pair the user admins in neither direction gets no affordance at all.
    const foreign = graph.edges.find((e) => e.id.includes('theirs') && e.variant === 'permission')
    expect(foreign).toMatchObject({ deletable: false, policyCallers: [] })
    expect(foreign?.policyAgentSlug).toBeUndefined()
  })

  it('revokes both directions when the user owns both callers', () => {
    const graph = buildGraph({
      agents: [agent('a'), agent('b')],
      accounts: [],
      mcps: [],
      topology: {
        ...emptyTopology,
        permissions: [
          { caller: 'a', target: 'b' },
          { caller: 'b', target: 'a' },
        ],
      },
    })
    const edge = graph.edges.find((e) => e.variant === 'permission')
    expect(edge).toMatchObject({ deletable: true, policyAgentSlug: 'a', policyCallers: ['a', 'b'] })
  })

  it('ignores invocations and permissions that reference unknown or self agents', () => {
    const graph = buildGraph({
      agents: [agent('a')],
      accounts: [],
      mcps: [],
      topology: {
        ...emptyTopology,
        invocations: [
          { caller: 'ghost', target: 'a', count: 1 },
          { caller: 'a', target: 'a', count: 9 },
        ],
        permissions: [{ caller: 'a', target: 'ghost' }],
      },
    })
    expect(graph.edges).toEqual([])
  })
})
