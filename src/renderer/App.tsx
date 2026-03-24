import { useState, useEffect, useRef } from 'react'
import { QueryProvider } from './providers/query-provider'
import { UserProvider } from './context/user-context'
import { AnalyticsProvider } from './context/analytics-context'
import { AuthGate } from './components/auth/auth-gate'
import { SelectionProvider } from './context/selection-context'
import { ConnectivityProvider } from './context/connectivity-context'
import { DialogProvider } from './context/dialog-context'
import { AppSidebar } from './components/layout/app-sidebar'
import { MainContent } from './components/layout/main-content'
import { SidebarProvider, SidebarInset } from './components/ui/sidebar'
import { TrayNavigationHandler } from './components/tray-navigation-handler'
import { GlobalNotificationHandler } from './components/notifications/global-notification-handler'
import { GettingStartedWizard } from './components/wizard/getting-started-wizard'
import { ErrorBoundary } from './components/ui/error-boundary'
import { PlatformLoginGate } from './components/platform/platform-login-gate'
import { useUserSettings } from './hooks/use-user-settings'
import { useTheme } from './hooks/use-theme'
import { useUser } from './context/user-context'
import { useAnalyticsTracking } from './context/analytics-context'

function AppContent() {
  useTheme()
  const [wizardOpen, setWizardOpen] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { isAuthMode, isAdmin } = useUser()
  const { identify } = useAnalyticsTracking()
  const hasAutoOpened = useRef(false)

  // Identify user on app open
  useEffect(() => {
    identify()
  }, [identify])

  // Auto-open wizard on first launch (non-admin auth users skip — they can't configure the server)
  useEffect(() => {
    if (userSettings && !userSettings.setupCompleted && !hasAutoOpened.current && (!isAuthMode || isAdmin)) {
      hasAutoOpened.current = true
      setWizardOpen(true)
    }
  }, [userSettings, isAuthMode, isAdmin])

  return (
    <PlatformLoginGate>
      <DialogProvider onOpenWizard={() => setWizardOpen(true)}>
        <TrayNavigationHandler>
          <GlobalNotificationHandler />
          <SidebarProvider className="h-screen">
            <AppSidebar />
            <SidebarInset className="min-w-0 h-full">
              <MainContent />
            </SidebarInset>
          </SidebarProvider>
        </TrayNavigationHandler>

        <GettingStartedWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
        />
      </DialogProvider>
    </PlatformLoginGate>
  )
}

export default function App() {
  return (
    <QueryProvider>
      <UserProvider>
        <AuthGate>
          <AnalyticsProvider>
            <SelectionProvider>
              <ConnectivityProvider>
                <ErrorBoundary>
                  <AppContent />
                </ErrorBoundary>
              </ConnectivityProvider>
            </SelectionProvider>
          </AnalyticsProvider>
        </AuthGate>
      </UserProvider>
    </QueryProvider>
  )
}
