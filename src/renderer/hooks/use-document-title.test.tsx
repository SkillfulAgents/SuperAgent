// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppLocation } from '@renderer/router/route-state'

const DOT = ' \u00b7 '
const DASH = ' \u2014 '

const mocks = vi.hoisted(() => ({
  routeLocation: { selectedAgentSlug: null, view: { kind: 'home' } } as AppLocation,
  routerMatches: [] as Array<{ params: Record<string, string | undefined>; fullPath?: string }>,
  agent: undefined as { name?: string; dashboards?: Array<{ slug: string; name: string }> } | undefined,
  session: undefined as
    | { name?: string; isActive?: boolean; isAwaitingInput?: boolean; hasUnreadNotifications?: boolean }
    | undefined,
  isStreaming: false,
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

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ isStreaming: mocks.isStreaming }),
}))

import {
  applyTitleIndicator,
  getDocumentTitle,
  getTitleIndicator,
  isTitleIndicatorAnimated,
  TITLE_INDICATOR_FRAME_MS,
  useDocumentTitle,
} from './use-document-title'

const AWAITING = ['\u25c6', '\u25c7'] // ◆ ◇
const WORKING = ['\u25d0', '\u25d1'] // ◐ ◑
const UNREAD = '\u25cf' // ●

function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

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
      getDocumentTitle({ location: location({ kind: 'xAgentPermissions' }, 'agent-one'), agentName: 'Agent One' }),
    ).toBe(`Agent One${DASH}Agent-to-agent Connections`)
    expect(
      getDocumentTitle({ location: location({ kind: 'inboundXAgent' }, 'agent-one'), agentName: 'Agent One' }),
    ).toBe(`Agent One${DASH}Called from Other Agents`)
    expect(
      getDocumentTitle({ location: location({ kind: 'completedTasks' }, 'agent-one'), agentName: 'Agent One' }),
    ).toBe(`Agent One${DASH}Completed One-time Tasks`)
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
      `Settings${DASH}Model Provider`,
    )
  })
})

describe('getTitleIndicator', () => {
  it('prioritises awaiting over working over unread and cycles frames', () => {
    expect(getTitleIndicator({}, 0)).toBeNull()
    expect(getTitleIndicator({ hasUnreadNotifications: true }, 0)).toBe(UNREAD)
    expect(getTitleIndicator({ hasUnreadNotifications: true }, 1)).toBe(UNREAD)
    expect(getTitleIndicator({ isActive: true, hasUnreadNotifications: true }, 0)).toBe(WORKING[0])
    expect(getTitleIndicator({ isStreaming: true }, 1)).toBe(WORKING[1])
    expect(getTitleIndicator({ isActive: true, isAwaitingInput: true }, 0)).toBe(AWAITING[0])
    expect(getTitleIndicator({ isAwaitingInput: true }, 3)).toBe(AWAITING[1])
  })

  it('only animates the working and awaiting states', () => {
    expect(isTitleIndicatorAnimated({})).toBe(false)
    expect(isTitleIndicatorAnimated({ hasUnreadNotifications: true })).toBe(false)
    expect(isTitleIndicatorAnimated({ isActive: true })).toBe(true)
    expect(isTitleIndicatorAnimated({ isStreaming: true })).toBe(true)
    expect(isTitleIndicatorAnimated({ isAwaitingInput: true })).toBe(true)
  })

  it('prefixes the title with the glyph', () => {
    expect(applyTitleIndicator('Launch Plan', null)).toBe('Launch Plan')
    expect(applyTitleIndicator('Launch Plan', UNREAD)).toBe(`${UNREAD} Launch Plan`)
  })
})

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'Old Title'
    mocks.routeLocation = location({ kind: 'home' })
    mocks.routerMatches = [{ params: {}, fullPath: '/' }]
    mocks.agent = undefined
    mocks.session = undefined
    mocks.isStreaming = false
    setTabHidden(false)
  })

  afterEach(() => {
    vi.useRealTimers()
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

  describe('hidden-tab status indicator', () => {
    const sessionTitle = `Launch Plan${DASH}Agent One`

    function openSession(session: NonNullable<typeof mocks.session>) {
      mocks.routeLocation = location({ kind: 'session', id: 'session-1' }, 'agent-one')
      mocks.routerMatches = [
        { params: { slug: 'agent-one' }, fullPath: '/agents/$slug' },
        { params: { sessionId: 'session-1' }, fullPath: '/agents/$slug/sessions/$sessionId' },
      ]
      mocks.agent = { name: 'Agent One' }
      mocks.session = { name: 'Launch Plan', ...session }
    }

    it('shows nothing while the tab is visible, even with something to report', async () => {
      openSession({ isAwaitingInput: true, hasUnreadNotifications: true })
      render(<DocumentTitleHarness />)
      await waitFor(() => expect(document.title).toBe(sessionTitle))
    })

    it('prefixes the unread dot only while hidden and drops it on return', async () => {
      openSession({ hasUnreadNotifications: true })
      render(<DocumentTitleHarness />)
      await waitFor(() => expect(document.title).toBe(sessionTitle))

      act(() => setTabHidden(true))
      await waitFor(() => expect(document.title).toBe(`${UNREAD} ${sessionTitle}`))

      act(() => setTabHidden(false))
      await waitFor(() => expect(document.title).toBe(sessionTitle))
    })

    it('animates the working glyph once per second while hidden', async () => {
      vi.useFakeTimers()
      openSession({ isActive: true })
      render(<DocumentTitleHarness />)
      act(() => setTabHidden(true))
      expect(document.title).toBe(`${WORKING[0]} ${sessionTitle}`)

      act(() => vi.advanceTimersByTime(TITLE_INDICATOR_FRAME_MS))
      expect(document.title).toBe(`${WORKING[1]} ${sessionTitle}`)

      act(() => vi.advanceTimersByTime(TITLE_INDICATOR_FRAME_MS))
      expect(document.title).toBe(`${WORKING[0]} ${sessionTitle}`)
    })

    it('switches to the awaiting blink and back to the dot as the session settles', async () => {
      vi.useFakeTimers()
      openSession({ isActive: true, isAwaitingInput: true })
      const { rerender } = render(<DocumentTitleHarness />)
      act(() => setTabHidden(true))
      expect(document.title).toBe(`${AWAITING[0]} ${sessionTitle}`)

      act(() => vi.advanceTimersByTime(TITLE_INDICATOR_FRAME_MS))
      expect(document.title).toBe(`${AWAITING[1]} ${sessionTitle}`)

      // Turn finished while we were away: the completion notification is unread.
      mocks.session = { name: 'Launch Plan', isActive: false, isAwaitingInput: false, hasUnreadNotifications: true }
      rerender(<DocumentTitleHarness />)
      expect(document.title).toBe(`${UNREAD} ${sessionTitle}`)

      // Idle state holds no timer, so time passing changes nothing.
      act(() => vi.advanceTimersByTime(TITLE_INDICATOR_FRAME_MS * 3))
      expect(document.title).toBe(`${UNREAD} ${sessionTitle}`)
    })

    it('treats a live stream as working before the active echo lands', async () => {
      openSession({ isActive: false })
      mocks.isStreaming = true
      render(<DocumentTitleHarness />)
      act(() => setTabHidden(true))
      await waitFor(() => expect(document.title).toBe(`${WORKING[0]} ${sessionTitle}`))
    })

    it('never decorates non-session views', async () => {
      mocks.routeLocation = location({ kind: 'home' }, 'agent-one')
      mocks.routerMatches = [{ params: { slug: 'agent-one' }, fullPath: '/agents/$slug' }]
      mocks.agent = { name: 'Agent One' }
      mocks.session = { name: 'Stale', isAwaitingInput: true }
      render(<DocumentTitleHarness />)
      act(() => setTabHidden(true))
      await waitFor(() => expect(document.title).toBe(`Agent One${DOT}Gamut`))
    })
  })
})
