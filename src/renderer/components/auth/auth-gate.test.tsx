// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirror auth-page.test.tsx's api mock: hoist a vi.fn so the module factory can
// reference it. AuthGate only uses stashRedirectTarget from '@renderer/lib/api'.
const { stashRedirectTarget } = vi.hoisted(() => ({
  stashRedirectTarget: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  stashRedirectTarget,
}))

// Control useUser() per case. AuthGate reads only these four fields off it.
const { useUser } = vi.hoisted(() => ({
  useUser: vi.fn(),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser,
}))

// Keep the auth children shallow — this test is about the stash effect, not the
// child render. (auth-client is globally mocked in test/setup.ts, but stubbing
// these avoids pulling in their form/query trees entirely.)
vi.mock('./auth-page', () => ({
  AuthPage: () => <div data-testid="auth-page" />,
}))
vi.mock('./force-password-change', () => ({
  ForcePasswordChange: () => <div data-testid="force-password-change" />,
}))

import { AuthGate } from './auth-gate'

type UserState = {
  isAuthMode: boolean
  isAuthenticated: boolean
  isPending: boolean
  mustChangePassword: boolean
}

function setUser(state: UserState) {
  // AuthGate only destructures these four; provide defaults for the rest so the
  // shape stays a valid UserContextValue from the consumer's perspective.
  vi.mocked(useUser).mockReturnValue(state as never)
}

describe('AuthGate cold-stash vs sign-out (wasAuthenticatedRef guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // `define` installs __AUTH_MODE__ as a real runtime global, so stubGlobal can
    // flip it per case (same mechanism as api.test.ts / history.test.ts).
    vi.stubGlobal('__AUTH_MODE__', true)
    // jsdom: replaceState is the clean way to set pathname/search/hash without
    // triggering a (jsdom-unsupported) real navigation.
    window.history.replaceState({}, '', '/')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cold deep-link: stashes the target once the session settles unauthenticated', () => {
    window.history.replaceState({}, '', '/agents/foo?tab=runs#section')

    // Session check still in flight → effect must not stash yet.
    setUser({ isAuthMode: true, isAuthenticated: false, isPending: true, mustChangePassword: false })
    const { rerender } = render(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    )
    expect(stashRedirectTarget).not.toHaveBeenCalled()

    // Settles unauthenticated → effect re-runs (isPending is in the dep array).
    setUser({ isAuthMode: true, isAuthenticated: false, isPending: false, mustChangePassword: false })
    rerender(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    )

    expect(stashRedirectTarget).toHaveBeenCalledTimes(1)
    expect(stashRedirectTarget).toHaveBeenCalledWith('/agents/foo?tab=runs#section')
  })

  it('sign-out: does NOT stash, so a signed-out path cannot leak into the next session', () => {
    window.history.replaceState({}, '', '/agents/foo?tab=runs#section')

    // First render authenticated → the wasAuthenticatedRef effect sets the ref.
    setUser({ isAuthMode: true, isAuthenticated: true, isPending: false, mustChangePassword: false })
    const { rerender } = render(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    )

    // Sign out → now unauthenticated, but the ref records this tab WAS authenticated,
    // so the cold-stash guard must suppress the stash.
    setUser({ isAuthMode: true, isAuthenticated: false, isPending: false, mustChangePassword: false })
    rerender(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    )

    expect(stashRedirectTarget).not.toHaveBeenCalled()
  })

  it('outside auth mode: never stashes', () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    window.history.replaceState({}, '', '/agents/foo')

    setUser({ isAuthMode: false, isAuthenticated: false, isPending: true, mustChangePassword: false })
    const { rerender } = render(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    )

    setUser({ isAuthMode: false, isAuthenticated: false, isPending: false, mustChangePassword: false })
    rerender(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    )

    expect(stashRedirectTarget).not.toHaveBeenCalled()
  })
})
