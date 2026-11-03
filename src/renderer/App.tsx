import { RouterProvider } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect } from 'react'
import { QueryProvider } from './providers/query-provider'
import { UserProvider, useUser } from './context/user-context'
import { AnalyticsProvider } from './context/analytics-context'
import { AuthGate } from './components/auth/auth-gate'
import { NavTransientProvider } from './context/nav-transient-context'
import { ConnectivityProvider } from './context/connectivity-context'
import { DraftsProvider } from './context/drafts-context'
import { SearchProvider } from './context/search-context'
import { Toaster } from './components/ui/sonner'
import { ErrorBoundary } from './components/ui/error-boundary'
import { router } from './router'

/**
 * Mounts the router. Read inside the provider stack so the live `queryClient`
 * (QueryClientProvider's instance — shared cache for loaders) and the full user
 * context are injected into the router context at render. `AuthGate` (an
 * ancestor) renders `<AuthPage/>` instead of this whole subtree while signed
 * out, so the router only mounts once authenticated.
 */
function RouterMount() {
  const queryClient = useQueryClient()
  const user = useUser()
  const userId = user.user?.id
  useLayoutEffect(() => {
    // AuthGate unmounts this subtree at sign-out, but the router retains its
    // matches. Newer Router versions reuse those matches on a same-URL remount
    // without loading again. Recheck access for the current session instead of
    // retaining the previous user's success/not-found state. A cold router has
    // no resolved location and performs its own initial load.
    if (user.isAuthMode && router.state.resolvedLocation) {
      void router.invalidate({ sync: true, forcePending: true })
    }
  }, [user.isAuthMode, userId])
  return <RouterProvider router={router} context={{ queryClient, user }} />
}

export default function App() {
  return (
    <QueryProvider>
      <UserProvider>
        <AuthGate>
          <AnalyticsProvider>
            <NavTransientProvider>
              <ConnectivityProvider>
                <DraftsProvider>
                  <SearchProvider>
                    <ErrorBoundary>
                      <RouterMount />
                      <Toaster />
                    </ErrorBoundary>
                  </SearchProvider>
                </DraftsProvider>
              </ConnectivityProvider>
            </NavTransientProvider>
          </AnalyticsProvider>
        </AuthGate>
      </UserProvider>
    </QueryProvider>
  )
}
