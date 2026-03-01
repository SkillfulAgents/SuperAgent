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
