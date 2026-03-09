import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Mock auth-client globally — UserProvider imports it at module level.
// When __AUTH_MODE__ is false the hooks are never called, but the import still runs.
vi.mock('@renderer/lib/auth-client', () => ({
  authClient: {},
  signIn: vi.fn(),
  signUp: vi.fn(),
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
