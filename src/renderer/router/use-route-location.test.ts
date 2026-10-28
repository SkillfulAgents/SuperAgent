// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import type { AppLocation } from './route-state'

// `useRouteLocation` reads the active route purely through `useRouterState`'s
// `select` callback. We stub the router so `useRouterState({ select })` simply
// runs `select` against a per-test fake state — this exercises the selector (the
// param-merge + deepest-match + empty-matches fallback) without a RouterProvider.
// (Same full-replacement style as history.test.ts; `use-route-location.ts` only
// imports `useRouterState` from this module, so a single-export mock is safe.)
const fakeState = { matches: [] as Array<Record<string, unknown>> }
vi.mock('@tanstack/react-router', () => ({
  useRouterState: <T>(opts: { select: (state: typeof fakeState) => T }): T => opts.select(fakeState),
}))

// test/setup.ts globally mocks @renderer/router/use-route-location to a constant
// home location (so leaf components render without a router). This file tests the
// REAL selector, so un-shadow it before importing the module under test.
vi.unmock('@renderer/router/use-route-location')

import { useRouteLocation } from './use-route-location'

// `useRouterState` is mocked to call `select` synchronously (no real React
// state), so `useRouteLocation` is a pure function of `fakeState` here. Named
// `use*` so eslint's rules-of-hooks treats this synchronous wrapper as a hook.
function useLocationFor(matches: Array<Record<string, unknown>>): AppLocation {
  fakeState.matches = matches
  return useRouteLocation()
}

describe('useRouteLocation', () => {
  it('merges ancestor params down to the deepest match (agent slug flows into a session leaf)', () => {
    // The session leaf's own params carry only `sessionId`; the agent `slug`
    // lives on the ancestor agent-layout match. Object.assign across matches must
    // carry it down (use-route-location.ts:21-23), and the deepest fullPath wins.
    const loc = useLocationFor([
      { params: { slug: 'a' }, search: {}, fullPath: '/agents/$slug' },
      { params: { sessionId: 's1' }, search: {}, fullPath: '/agents/$slug/sessions/$sessionId' },
    ])
    expect(loc).toEqual({ selectedAgentSlug: 'a', view: { kind: 'session', id: 's1' } })
  })

  it('falls back to the global home when there are no matches (deepest?.fullPath ?? "/")', () => {
    // Empty matches: `deepest` is undefined, so the snapshot `to` defaults to '/'
    // (use-route-location.ts:25-26) and must NOT crash on the param/search merge.
    const loc = useLocationFor([])
    expect(loc).toEqual({ selectedAgentSlug: null, view: { kind: 'home' } })
  })
})
