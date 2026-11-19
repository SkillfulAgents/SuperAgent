// @vitest-environment jsdom

// What a chat turn does to the root layout. The tab title follows the current
// agent, the current session and the streaming flag; those change several
// times in one turn. This file drives the real RootLayout, the real
// DialogProvider and the real title hook from a store that stands in for those
// three subscriptions, and counts who renders.

import { memo, useContext, useSyncExternalStore } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppLocation } from '@renderer/router/route-state'

vi.unmock('@renderer/context/dialog-context')

const h = vi.hoisted(() => {
  interface TurnState {
    agent: { name: string } | undefined
    session: { name?: string; isActive?: boolean } | undefined
    isStreaming: boolean
  }
  let state: TurnState = { agent: undefined, session: undefined, isStreaming: false }
  const listeners = new Set<() => void>()
  return {
    turn: {
      get: () => state,
      set(patch: Partial<TurnState>) {
        state = { ...state, ...patch }
        listeners.forEach((listener) => listener())
      },
      reset() {
        state = { agent: undefined, session: undefined, isStreaming: false }
      },
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    counts: { root: 0, hookConsumer: 0, rawConsumer: 0, onboardingConsumer: 0 },
    routerState: {
      location: { pathname: '/agents/a1/sessions/s1', searchStr: '', search: {} as Record<string, unknown> },
      matches: [] as Array<{ params: Record<string, string | undefined>; fullPath?: string }>,
    },
    routeLocation: { selectedAgentSlug: 'a1', view: { kind: 'session', id: 's1' } } as AppLocation,
    router: {
      state: { location: { pathname: '/agents/a1/sessions/s1', searchStr: '', search: {} } },
      navigate: vi.fn(() => Promise.resolve()),
      history: { push: vi.fn() },
    },
    user: { isAuthMode: false, isAdmin: false, user: null },
    settings: { data: { setupCompleted: true } },
    search: { open: false },
    passthrough: ({ children }: { children: React.ReactNode }) => children,
  }
})

// ── the three subscriptions of the title hook ────────────────────────────────
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: useSyncExternalStore(h.turn.subscribe, () => h.turn.get().agent) }),
}))
vi.mock('@renderer/hooks/use-sessions', () => ({
  useSession: () => ({ data: useSyncExternalStore(h.turn.subscribe, () => h.turn.get().session) }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ isStreaming: useSyncExternalStore(h.turn.subscribe, () => h.turn.get().isStreaming) }),
}))
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => h.routeLocation,
}))

// ── the router ───────────────────────────────────────────────────────────────
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => h.router,
  useRouterState: <T,>(opts: { select: (state: typeof h.routerState) => T }): T => opts.select(h.routerState),
  // The real Outlet is memoized the same way: it takes no props, so a parent
  // render alone never reaches the routes below it.
  Outlet: memo(function Outlet() {
    return <Consumers />
  }),
  lazyRouteComponent: (_load: unknown, name: string) =>
    Object.assign(() => <div data-testid={`lazy-${name}`} />, { preload: () => Promise.resolve() }),
}))

// ── what the root layout reads for itself ────────────────────────────────────
vi.mock('@renderer/hooks/use-theme', () => ({
  // First hook RootLayoutContent calls: one call per render of it.
  useTheme: () => {
    h.counts.root++
  },
}))
vi.mock('@renderer/hooks/use-inset-radius', () => ({ useInsetRadius: () => {} }))
vi.mock('@renderer/hooks/use-keyboard-viewport', () => ({ useKeyboardViewport: () => {} }))
vi.mock('@renderer/hooks/use-user-settings', () => ({ useUserSettings: () => h.settings }))
vi.mock('@renderer/hooks/use-settings', () => ({ useSettings: () => h.settings }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => h.user }))
vi.mock('@renderer/context/search-context', () => ({ useSearch: () => h.search }))
vi.mock('@renderer/lib/error-reporting', () => ({
  setRendererErrorReportingEnabled: () => {},
  setRendererErrorReportingUser: () => {},
}))
vi.mock('@renderer/router/auth-boundary', () => ({
  AuthRouteBoundary: ({ children }: { children: React.ReactNode }) => children,
}))

// ── chrome and handlers the root layout mounts, not under test ───────────────
vi.mock('@renderer/context/model-availability-action-context', () => ({ ModelAvailabilityActionProvider: h.passthrough }))
vi.mock('@renderer/context/update-status-context', () => ({ UpdateStatusProvider: h.passthrough }))
vi.mock('@renderer/context/cmd-hint-context', () => ({ CmdHintProvider: h.passthrough }))
vi.mock('@renderer/components/ui/sidebar', () => ({ SidebarProvider: h.passthrough, SidebarInset: h.passthrough }))
vi.mock('@renderer/components/agents/onboarding-setup-dialog', () => ({ OnboardingSetupDialog: () => null }))
vi.mock('@renderer/components/update-toast-notifier', () => ({ UpdateToastNotifier: () => null }))
vi.mock('@renderer/components/layout/app-sidebar', () => ({ AppSidebar: () => null }))
vi.mock('@renderer/components/layout/window-controls', () => ({ WindowControls: () => null }))
vi.mock('@renderer/components/settings/container-setup-handler', () => ({ ContainerSetupHandler: () => null }))
vi.mock('@renderer/components/menu-command-handler', () => ({ MenuCommandHandler: () => null }))
vi.mock('@renderer/components/package-import-handler', () => ({ PackageImportHandler: () => null }))
vi.mock('@renderer/components/history-navigation-handler', () => ({ HistoryNavigationHandler: () => null }))
vi.mock('@renderer/components/notifications/global-notification-handler', () => ({ GlobalNotificationHandler: () => null }))
vi.mock('@renderer/components/notifications/agent-status-push', () => ({ AgentStatusPush: () => null }))
vi.mock('@renderer/components/signup-handoff-consumer', () => ({ SignupHandoffConsumer: () => null }))

import { DialogContext, useDialogs } from '@renderer/context/dialog-context'
import { useOnboarding } from '@renderer/context/onboarding-context'
import { RootLayout } from './route-layouts'

// The ways the routes read the two root contexts: useDialogs() (sidebar,
// settings, voice button), useContext(DialogContext) (every transcript link),
// useOnboarding() (onboarding and Team Brain setup).
function HookConsumer() {
  h.counts.hookConsumer++
  useDialogs()
  return null
}
function RawConsumer() {
  h.counts.rawConsumer++
  useContext(DialogContext)
  return null
}
function OnboardingConsumer() {
  h.counts.onboardingConsumer++
  useOnboarding()
  return null
}
function Consumers() {
  return (
    <>
      <HookConsumer />
      <RawConsumer />
      <OnboardingConsumer />
    </>
  )
}

const DASH = ' — '

beforeEach(() => {
  h.turn.reset()
  h.counts.root = 0
  h.counts.hookConsumer = 0
  h.counts.rawConsumer = 0
  h.counts.onboardingConsumer = 0
  h.search = { open: false }
  document.title = ''
})

describe('RootLayout during a chat turn', () => {
  it('does not re-render, and re-renders no dialog or onboarding consumer, while the title follows the turn', () => {
    render(<RootLayout />)
    expect(document.title).toBe(`Session${DASH}a1`)
    const mounted = { ...h.counts }
    expect(mounted).toEqual({ root: 1, hookConsumer: 1, rawConsumer: 1, onboardingConsumer: 1 })

    // One turn as the title hook sees it: the agent and session arrive, the
    // session goes active, the stream starts and stops, the session is named
    // and goes idle.
    act(() => h.turn.set({ agent: { name: 'Agent One' } }))
    expect(document.title).toBe(`Session${DASH}Agent One`)
    act(() => h.turn.set({ session: { name: 'Launch Plan', isActive: false } }))
    expect(document.title).toBe(`Launch Plan${DASH}Agent One`)
    act(() => h.turn.set({ session: { name: 'Launch Plan', isActive: true } }))
    act(() => h.turn.set({ isStreaming: true }))
    act(() => h.turn.set({ isStreaming: false }))
    act(() => h.turn.set({ session: { name: 'Launch Plan v2', isActive: true } }))
    act(() => h.turn.set({ session: { name: 'Launch Plan v2', isActive: false } }))

    // The title kept up, so the subscriptions are live...
    expect(document.title).toBe(`Launch Plan v2${DASH}Agent One`)
    // ...and nothing but the title component rendered for them.
    expect(h.counts).toEqual(mounted)
  })

  it('re-renders no consumer when the root layout itself re-renders', () => {
    const { rerender } = render(<RootLayout />)
    const mounted = { ...h.counts }

    // Something the root layout does subscribe to changes (search opening,
    // settings refetching): the layout renders, the context values hold.
    h.search = { open: true }
    rerender(<RootLayout />)
    h.search = { open: false }
    rerender(<RootLayout />)

    // (Three renders: opening search also latches searchEverOpened.)
    expect(h.counts.root).toBe(mounted.root + 3)
    expect(h.counts.hookConsumer).toBe(mounted.hookConsumer)
    expect(h.counts.rawConsumer).toBe(mounted.rawConsumer)
    expect(h.counts.onboardingConsumer).toBe(mounted.onboardingConsumer)
  })

  it('keeps the title up to date while the wizard covers the routes', async () => {
    // First run in local mode opens the wizard, which replaces the Outlet;
    // the title component is mounted beside it, not under it.
    const settings = h.settings
    h.settings = { data: { setupCompleted: false } }
    try {
      const { findByTestId } = render(<RootLayout />)
      await findByTestId('lazy-GettingStartedWizard')
      act(() => h.turn.set({ agent: { name: 'Agent One' }, session: { name: 'Launch Plan' } }))
      expect(document.title).toBe(`Launch Plan${DASH}Agent One`)
    } finally {
      h.settings = settings
    }
  })
})
