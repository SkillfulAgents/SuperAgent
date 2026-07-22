// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppLocation } from '@renderer/router/route-state'

const DOT = ' \u00b7 '
const DASH = ' \u2014 '

const mocks = vi.hoisted(() => ({
  routeLocation: { selectedAgentSlug: null, view: { kind: 'home' } } as AppLocation,
  routerMatches: [] as Array<{ params: Record<string, string | undefined>; fullPath?: string }>,
  agent: undefined as { name?: string; dashboards?: Array<{ slug: string; name: string }> } | undefined,
  session: undefined as { name?: string } | undefined,
}))

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => mocks.routeLocation,
}))

vi.mock('@tanstack/react-router', () => ({
  useRouterState: <T,>(opts: {
    select: (state: { matches: Array<{ params: Record<string, string | undefined>; fullPath?: string }> }) => T
  }): T => opts.select({ matches: mocks.routerMatches }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: mocks.agent }),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSession: () => ({ data: mocks.session }),
}))

import { getDocumentTitle, useDocumentTitle } from './use-document-title'

function DocumentTitleHarness() {
  useDocumentTitle()
  return null
}

function location(view: AppLocation['view'], selectedAgentSlug: string | null = null): AppLocation {
  return { selectedAgentSlug, view }
}

describe('getDocumentTitle', () => {
  it('formats global and agent home titles', () => {
    expect(getDocumentTitle({ location: location({ kind: 'home' }) })).toBe('Gamut')
    expect(getDocumentTitle({ location: location({ kind: 'home' }, 'agent-one'), agentName: 'Agent One' })).toBe(
      `Agent One${DOT}Gamut`,
    )
    expect(getDocumentTitle({ location: location({ kind: 'home' }, 'agent-one') })).toBe(`agent-one${DOT}Gamut`)
  })

  it('formats sessions and agent-scoped tool views', () => {
    const base = location({ kind: 'session', id: 'session-1' }, 'agent-one')

    expect(getDocumentTitle({ location: base, agentName: 'Agent One', sessionName: 'Launch Plan' })).toBe(
      `Launch Plan${DASH}Agent One`,
    )
    expect(getDocumentTitle({ location: base })).toBe(`Session${DASH}agent-one`)
    expect(getDocumentTitle({ location: location({ kind: 'connections' }, 'agent-one'), agentName: 'Agent One' })).toBe(
      `Agent One${DASH}Connections`,
    )
    expect(getDocumentTitle({
      location: location({
        kind: 'connections',
        detail: { rowKey: 'account-1', source: 'home', view: 'logs' },
      }, 'agent-one'),
      agentName: 'Agent One',
    })).toBe(`Agent One${DASH}Connection Logs`)
    expect(getDocumentTitle({ location: location({ kind: 'apiLogs' }, 'agent-one'), agentName: 'Agent One' })).toBe(
      `Agent One${DASH}API Logs`,
    )
    expect(
      getDocumentTitle({
        location: location({ kind: 'dashboard', slug: 'sales-dashboard' }, 'agent-one'),
        agentName: 'Agent One',
        dashboardName: 'Sales Dashboard',
      }),
    ).toBe(`Agent One${DASH}Sales Dashboard`)
  })

  it('formats notifications and settings routes', () => {
    expect(getDocumentTitle({ location: location({ kind: 'notifications' }) })).toBe(`Notifications${DOT}Gamut`)
    expect(getDocumentTitle({ location: location({ kind: 'home' }), isSettingsRoute: true })).toBe(`Settings${DOT}Gamut`)
    expect(getDocumentTitle({ location: location({ kind: 'home' }), isSettingsRoute: true, settingsTab: 'llm' })).toBe(
      `Settings${DASH}LLM Provider`,
    )
  })
})

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'Old Title'
    mocks.routeLocation = location({ kind: 'home' })
    mocks.routerMatches = [{ params: {}, fullPath: '/' }]
    mocks.agent = undefined
    mocks.session = undefined
  })

  it('applies the current route title and updates on navigation', async () => {
    const { rerender } = render(<DocumentTitleHarness />)

    await waitFor(() => expect(document.title).toBe('Gamut'))

    mocks.routeLocation = location({ kind: 'home' }, 'agent-one')
    mocks.routerMatches = [{ params: { slug: 'agent-one' }, fullPath: '/agents/$slug' }]
    mocks.agent = { name: 'Agent One' }
    rerender(<DocumentTitleHarness />)

    await waitFor(() => expect(document.title).toBe(`Agent One${DOT}Gamut`))

    mocks.routeLocation = location({ kind: 'session', id: 'session-1' }, 'agent-one')
    mocks.routerMatches = [
      { params: { slug: 'agent-one' }, fullPath: '/agents/$slug' },
      { params: { sessionId: 'session-1' }, fullPath: '/agents/$slug/sessions/$sessionId' },
    ]
    mocks.session = { name: 'Launch Plan' }
    rerender(<DocumentTitleHarness />)

    await waitFor(() => expect(document.title).toBe(`Launch Plan${DASH}Agent One`))
  })

  it('derives settings titles from the router matches even though AppLocation degrades to home', async () => {
    mocks.routeLocation = location({ kind: 'home' })
    mocks.routerMatches = [
      { params: {}, fullPath: '/settings' },
      { params: { tab: 'connections' }, fullPath: '/settings/$tab' },
    ]

    render(<DocumentTitleHarness />)

    await waitFor(() => expect(document.title).toBe(`Settings${DASH}Connections`))
  })
})
