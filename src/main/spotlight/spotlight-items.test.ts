import { describe, expect, it } from 'vitest'
import {
  diffItems,
  encodeSpotlightId,
  fingerprint,
  itemsForTarget,
  parseSpotlightId,
  workspaceItems,
  type SpotlightRef,
} from './spotlight-items'

describe('spotlight item ids', () => {
  const refs: SpotlightRef[] = [
    { kind: 'agent', target: 'local', agentSlug: 'finance-x1' },
    { kind: 'session', target: 'cloud', agentSlug: 'finance-x1', sessionId: 'abc-123' },
    { kind: 'dashboard', target: 'local', agentSlug: 'finance-x1', dashboardSlug: 'revenue' },
    { kind: 'workspace', target: 'cloud' },
  ]

  it.each(refs)('round-trips $kind on $target', (ref) => {
    expect(parseSpotlightId(encodeSpotlightId(ref))).toEqual(ref)
  })

  it('keeps slugs that contain the separator intact', () => {
    const ref: SpotlightRef = { kind: 'dashboard', target: 'cloud', agentSlug: 'a/b', dashboardSlug: 'c d/é' }
    expect(parseSpotlightId(encodeSpotlightId(ref))).toEqual(ref)
  })

  it.each([
    ['another version', 'v2/agent/local/finance'],
    ['an unknown kind', 'v1/folder/local/finance'],
    ['an unknown target', 'v1/agent/remote/finance'],
    ['a missing part', 'v1/session/local/finance'],
    ['an extra part', 'v1/agent/local/finance/more'],
    ['an empty part', 'v1/dashboard/local//revenue'],
    ['malformed encoding', 'v1/agent/local/%E0%A4%A'],
    ['the spike format', 'local|superagent://agent/finance'],
  ])('rejects %s', (_label, id) => {
    expect(parseSpotlightId(id)).toBeNull()
  })
})

describe('itemsForTarget', () => {
  const agents = [
    {
      slug: 'finance-x1',
      name: 'Finance',
      lastActivityAt: '2026-10-20T10:00:00.000Z',
      dashboards: [{ slug: 'revenue', name: 'Revenue' }],
    },
  ]
  const sessions = new Map([
    ['finance-x1', [
      { id: 's1', name: 'Q3 reconciliation', lastActivityAt: '2026-10-19T09:00:00.000Z' },
      { id: 's2', name: '   ', lastActivityAt: null },
      { id: 's3', name: null },
    ]],
  ])

  it('labels every agent, dashboard and named session with its Superagent', () => {
    const items = itemsForTarget('cloud', agents, sessions)
    expect(items.map(({ title, subtitle, domain }) => ({ title, subtitle, domain }))).toEqual([
      { title: 'Finance', subtitle: 'Agent · Cloud', domain: 'cloud' },
      { title: 'Revenue', subtitle: 'Dashboard · Finance · Cloud', domain: 'cloud' },
      { title: 'Q3 reconciliation', subtitle: 'Session · Finance · Cloud', domain: 'cloud' },
    ])
  })

  it('identifies each item by what it opens', () => {
    const ids = itemsForTarget('local', agents, sessions).map((item) => parseSpotlightId(item.id))
    expect(ids).toEqual([
      { kind: 'agent', target: 'local', agentSlug: 'finance-x1' },
      { kind: 'dashboard', target: 'local', agentSlug: 'finance-x1', dashboardSlug: 'revenue' },
      { kind: 'session', target: 'local', agentSlug: 'finance-x1', sessionId: 's1' },
    ])
  })

  it('orders by activity, and tolerates a missing or unreadable timestamp', () => {
    const items = itemsForTarget('local', [{ slug: 'a', name: 'A', lastActivityAt: 'not a date' }], new Map())
    expect(items[0].lastUsedAt).toBeNull()
    expect(itemsForTarget('local', agents, sessions).at(-1)?.lastUsedAt).toBe(Date.parse('2026-10-19T09:00:00.000Z'))
  })

  it('offers a switch-to result for each side', () => {
    expect(workspaceItems().map((item) => parseSpotlightId(item.id))).toEqual([
      { kind: 'workspace', target: 'local' },
      { kind: 'workspace', target: 'cloud' },
    ])
  })
})

describe('diffItems', () => {
  const [agent, dashboard, session] = itemsForTarget(
    'local',
    [{ slug: 'a', name: 'A', dashboards: [{ slug: 'd', name: 'D' }] }],
    new Map([['a', [{ id: 's', name: 'S' }]]]),
  )
  const indexed = new Map([agent, dashboard, session].map((item) => [item.id, fingerprint(item)]))

  it('sends nothing when nothing changed', () => {
    expect(diffItems(indexed, [agent, dashboard, session])).toEqual({ upsert: [], remove: [] })
  })

  it('re-sends only what changed and removes what is gone', () => {
    const renamed = { ...session, title: 'Renamed' }
    expect(diffItems(indexed, [agent, renamed])).toEqual({ upsert: [renamed], remove: [dashboard.id] })
  })
})
