import { QueryProvider } from './providers/query-provider'
import { UserProvider } from './context/user-context'
import { AnalyticsProvider } from './context/analytics-context'
import { AuthGate } from './components/auth/auth-gate'
import { NavTransientProvider } from './context/nav-transient-context'
import { ConnectivityProvider } from './context/connectivity-context'
import { DraftsProvider } from './context/drafts-context'
import { SearchProvider } from './context/search-context'
import { Toaster } from './components/ui/sonner'
import { ErrorBoundary } from './components/ui/error-boundary'
import { router } from './router'
import { RouterMount } from './router/auth-boundary'

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
                      <RouterMount router={router} />
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
