import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { createElement } from 'react'

const signIn = {
  email: vi.fn(),
  oauth2: vi.fn(),
}

const signUp = {
  email: vi.fn(),
}

// Mock auth-client globally — UserProvider imports it at module level.
// When __AUTH_MODE__ is false the hooks are never called, but the import still runs.
vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {},
  signIn,
  signUp,
  signOut: vi.fn(),
  useSession: () => ({ data: null, isPending: false }),
}))

// Mock server analytics globally — it imports `fs` via tenant-id.ts which
// breaks in tests that mock `fs` without a full default export.
vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
  setServerAnalyticsVersion: vi.fn(),
}))

// Mock analytics context globally — components use useAnalyticsTracking
// which requires an AnalyticsProvider that depends on settings/user context.
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn(), identify: vi.fn() }),
  AnalyticsProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// Many components now call useNavigate() (router-driven navigation). Renderer
// unit tests render leaf components WITHOUT a RouterProvider, so stub navigation
// to a no-op — these tests assert component rendering/behavior, not real route
// changes (which are covered by router unit tests + E2E). Without this, the real
// useNavigate returns a rejected promise outside a router, surfacing as a
// mis-attributed unhandled rejection. File-level vi.mock of the module overrides
// this where a test needs different behavior.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => () => {} }
})

// `AppLink` (ui/app-link) imports the router singleton — which pulls in
// history.ts/`__WEB__` and needs a RouterProvider at render. Renderer unit tests
// have neither, so stub it as a plain anchor that forwards the props tests
// inspect (onClick, className, data-testid). A file-level vi.mock overrides this
// where a test needs the real link.
vi.mock('@renderer/components/ui/app-link', () => ({
  // Strip the link-specific props so they don't land as DOM attributes; forward
  // the rest (onClick/className/data-testid) to a plain anchor.
  AppLink: ({ children, to, params, search, activeClassName: _ac, activeOptions: _ao, noDrag: _nd, ...props }: Record<string, unknown> & { children?: unknown }) =>
    createElement(
      'a',
      {
        href: '#',
        // Expose the route target so tests can assert navigation (the real
        // <a href> isn't built in jsdom; data-* attrs avoid React DOM warnings).
        'data-to': to,
        'data-params': params ? JSON.stringify(params) : undefined,
        'data-search': search ? JSON.stringify(search) : undefined,
        ...props,
      },
      children as never,
    ),
}))

// DialogContext drives global settings via the router now (R12). Renderer unit
// tests have no RouterProvider, so stub it — DialogProvider passes children
// through and useDialogs returns no-ops. A file-level mock overrides where a test
// needs to assert on these (e.g. app-sidebar.test).
vi.mock('@renderer/context/dialog-context', () => ({
  DialogProvider: ({ children }: { children: React.ReactNode }) => children,
  useDialogs: () => ({ openSettings: vi.fn(), closeSettings: vi.fn(), openWizard: vi.fn() }),
}))

// Components read navigation state via `useRouteLocation()` now (R14, the route-
// derived replacement for `useSelection`). It calls `useRouterState()`, which
// throws outside a RouterProvider — renderer unit tests have none. Default it to
// the global home; a file-level vi.mock overrides where a test asserts behavior
// that depends on the active view/slug.
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ selectedAgentSlug: null, view: { kind: 'home' } }),
}))
