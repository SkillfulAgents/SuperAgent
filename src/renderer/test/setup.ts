import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

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
// to a no-op — these tests assert SelectionContext/behavior, not real route
// changes (which are covered by router unit tests + E2E). Without this, the real
// useNavigate returns a rejected promise outside a router, surfacing as a
// mis-attributed unhandled rejection. File-level vi.mock of the module overrides
// this where a test needs different behavior.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => () => {} }
})
