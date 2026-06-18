import { describe, it, expect } from 'vitest'
import { encodeLocation, decodeLocation, type AppLocation, type RouteSnapshot } from './route-state'

/**
 * Pins the codec inverse: encode → (mock match snapshot) → decode must equal the
 * original AppLocation for every AgentView kind. A drift between encode and decode
 * fails loudly here.
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

  it('normalizes the agent-home index trailing slash (real fullPath is /agents/$slug/)', () => {
    expect(decodeLocation({ to: '/agents/$slug/', params: { slug: 'x' }, search: {} })).toEqual({
      selectedAgentSlug: 'x',
      view: { kind: 'home' },
    })
  })

  // ── decoder-only degradation paths ──────────────────────────────────────────
  // These feed decodeLocation snapshots that encodeLocation can never EMIT (a
  // half-pair, an out-of-enum source, a non-string session, missing params), so
  // they are NOT round-trip cases — they pin the decoder's defensive guards.

  it('drops a connections half-pair (detail without source) to the bare connections view', () => {
    expect(
      decodeLocation({ to: '/agents/$slug/connections', params: { slug: 'a' }, search: { detail: 'account-1' } }),
    ).toEqual({
      selectedAgentSlug: 'a',
      view: { kind: 'connections' },
    })
  })

  it('drops a connections half-pair (source without detail) to the bare connections view', () => {
    expect(
      decodeLocation({ to: '/agents/$slug/connections', params: { slug: 'a' }, search: { source: 'home' } }),
    ).toEqual({
      selectedAgentSlug: 'a',
      view: { kind: 'connections' },
    })
  })

  it('drops connections detail when source is present but out of enum (decoder coupling guard)', () => {
    expect(
      decodeLocation({
        to: '/agents/$slug/connections',
        params: { slug: 'a' },
        search: { detail: 'account-1', source: 'garbage' },
      }),
    ).toEqual({
      selectedAgentSlug: 'a',
      view: { kind: 'connections' },
    })
  })

  it('drops a non-string chat ?session= so the chat view has no sessionId', () => {
    // The `typeof search.session === 'string'` guard (route-state.ts) must reject
    // a coerced number/array session. Round-trips only ever feed a clean string.
    const decoded = decodeLocation({
      to: '/agents/$slug/chat/$integrationId',
      params: { slug: 'a', integrationId: 'i' },
      search: { session: 123 },
    })
    expect(decoded).toEqual({
      selectedAgentSlug: 'a',
      view: { kind: 'chat', integrationId: 'i' },
    })
    expect(decoded.view).not.toHaveProperty('sessionId')
  })

  it('tolerates a missing slug/sessionId on a matched agent template (defensive ?? fallbacks)', () => {
    expect(decodeLocation({ to: '/agents/$slug/sessions/$sessionId', params: {}, search: {} })).toEqual({
      selectedAgentSlug: null,
      view: { kind: 'session', id: '' },
    })
  })

  it('degrades an unknown agent sub-path to the global home (default branch)', () => {
    expect(decodeLocation({ to: '/agents/$slug/unknownthing', params: { slug: 'a' }, search: {} })).toEqual({
      selectedAgentSlug: null,
      view: { kind: 'home' },
    })
  })

  it('preserves the bare root "/" (length>1 guard does not strip it to "")', () => {
    expect(decodeLocation({ to: '/', params: {}, search: {} })).toEqual({
      selectedAgentSlug: null,
      view: { kind: 'home' },
    })
  })
})
