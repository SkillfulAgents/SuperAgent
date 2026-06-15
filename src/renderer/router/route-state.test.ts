import { describe, it, expect } from 'vitest'
import { encodeLocation, decodeLocation, type AppLocation, type RouteSnapshot } from './route-state'

/**
 * Pins the codec inverse: encode → (mock match snapshot) → decode must equal the
 * original AppLocation for every AgentView kind. A drift between encode and decode
 * fails loudly here (migration plan §4.1, §11.1).
 */
function roundTrip(loc: AppLocation): AppLocation {
  const nav = encodeLocation(loc) as unknown as {
    to: string
    params?: Record<string, string>
    search?: Record<string, unknown>
  }
  const snap: RouteSnapshot = {
    to: nav.to,
    params: nav.params ?? {},
    search: nav.search ?? {},
  }
  return decodeLocation(snap)
}

const SLUG = 'my-agent'

// Canonical AppLocations. Notifications is globally scoped, so its canonical slug
// is null (navigating to it drops agent scope — see encodeLocation).
const cases: AppLocation[] = [
  { selectedAgentSlug: null, view: { kind: 'home' } },
  { selectedAgentSlug: null, view: { kind: 'notifications' } },
  { selectedAgentSlug: SLUG, view: { kind: 'home' } },
  { selectedAgentSlug: SLUG, view: { kind: 'session', id: 'sess-1' } },
  { selectedAgentSlug: SLUG, view: { kind: 'task', id: 'task-1' } },
  { selectedAgentSlug: SLUG, view: { kind: 'webhook', id: 'wh-1' } },
  { selectedAgentSlug: SLUG, view: { kind: 'chat', integrationId: 'int-1' } },
  { selectedAgentSlug: SLUG, view: { kind: 'chat', integrationId: 'int-1', sessionId: 'cs-1' } },
  { selectedAgentSlug: SLUG, view: { kind: 'dashboard', slug: 'dash-1' } },
  { selectedAgentSlug: SLUG, view: { kind: 'apiLogs' } },
  { selectedAgentSlug: SLUG, view: { kind: 'connections' } },
  { selectedAgentSlug: SLUG, view: { kind: 'connections', detail: { rowKey: 'account-123', source: 'home' } } },
  { selectedAgentSlug: SLUG, view: { kind: 'connections', detail: { rowKey: 'mcp-456', source: 'list' } } },
]

describe('route-state codec', () => {
  it.each(cases)('round-trips $view.kind (slug=$selectedAgentSlug)', (loc) => {
    expect(roundTrip(loc)).toEqual(loc)
  })

  it('emits agent-scoped URLs with the slug param', () => {
    expect(encodeLocation({ selectedAgentSlug: SLUG, view: { kind: 'session', id: 'sess-1' } })).toEqual({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: SLUG, sessionId: 'sess-1' },
    })
  })

  it('drops agent scope for notifications', () => {
    expect(encodeLocation({ selectedAgentSlug: SLUG, view: { kind: 'notifications' } })).toEqual({
      to: '/notifications',
    })
  })

  it('routes the global home to /', () => {
    expect(encodeLocation({ selectedAgentSlug: null, view: { kind: 'home' } })).toEqual({ to: '/' })
  })

  it('decodes an unknown route to the global home (settings is handled separately)', () => {
    expect(decodeLocation({ to: '/settings/general', params: {}, search: {} })).toEqual({
      selectedAgentSlug: null,
      view: { kind: 'home' },
    })
  })
})
