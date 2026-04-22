import { useState, useEffect, useRef } from 'react'
import { QueryProvider } from './providers/query-provider'
import { UserProvider } from './context/user-context'
import { AnalyticsProvider } from './context/analytics-context'
import { AuthGate } from './components/auth/auth-gate'
import { SelectionProvider } from './context/selection-context'
import { ConnectivityProvider } from './context/connectivity-context'
import { DialogProvider } from './context/dialog-context'
import { DraftsProvider } from './context/drafts-context'
import { AppSidebar } from './components/layout/app-sidebar'
import { MainContent } from './components/layout/main-content'
import { WindowControls } from './components/layout/window-controls'
import { SidebarProvider, SidebarInset } from './components/ui/sidebar'
import { TrayNavigationHandler } from './components/tray-navigation-handler'
import { GlobalNotificationHandler } from './components/notifications/global-notification-handler'
import { GettingStartedWizard } from './components/wizard/getting-started-wizard'
import { ErrorBoundary } from './components/ui/error-boundary'
import { useUserSettings } from './hooks/use-user-settings'
import { useTheme } from './hooks/use-theme'
import { useInsetRadius } from './hooks/use-inset-radius'
import { useUser } from './context/user-context'
import { useAnalyticsTracking } from './context/analytics-context'
import { useSettings } from './hooks/use-settings'
import { setRendererErrorReportingEnabled, setRendererErrorReportingUser } from './lib/error-reporting'

function AppContent() {
  useTheme()
  useInsetRadius()

  const [wizardOpen, setWizardOpen] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { data: globalSettings } = useSettings()
  const { isAuthMode, isAdmin, user } = useUser()
  const { identify } = useAnalyticsTracking()
  const hasAutoOpened = useRef(false)

  // Identify user on app open
  useEffect(() => {
    identify()
  }, [identify])

  // Sync error reporting settings
  const shareErrorReports = globalSettings?.shareErrorReports
  useEffect(() => {
    if (shareErrorReports !== undefined) {
      setRendererErrorReportingEnabled(shareErrorReports !== false)
    }
  }, [shareErrorReports])

  // Set user identity on error reports when logged in with platform
  useEffect(() => {
    if (user) {
      setRendererErrorReportingUser({ id: user.id, email: user.email })
    } else {
      setRendererErrorReportingUser(null)
    }
  }, [user])

  // Auto-open wizard on first launch (non-admin auth users skip — they can't configure the server)
  useEffect(() => {
    if (userSettings && !userSettings.setupCompleted && !hasAutoOpened.current && (!isAuthMode || isAdmin)) {
      hasAutoOpened.current = true
      setWizardOpen(true)
    }
  }, [userSettings, isAuthMode, isAdmin])

  return (
    <DialogProvider onOpenWizard={() => setWizardOpen(true)}>
      <WindowControls />
      {wizardOpen ? (
        <GettingStartedWizard onClose={() => setWizardOpen(false)} />
      ) : (
        <TrayNavigationHandler>
          <GlobalNotificationHandler />
          <SidebarProvider className="h-screen">
            <AppSidebar />
            <SidebarInset className="min-w-0">
              <MainContent />
            </SidebarInset>
          </SidebarProvider>
        </TrayNavigationHandler>
      )}
    </DialogProvider>
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
                <DraftsProvider>
                  <ErrorBoundary>
                    <AppContent />
                  </ErrorBoundary>
                </DraftsProvider>
              </ConnectivityProvider>
            </SelectionProvider>
          </AnalyticsProvider>
        </AuthGate>
      </UserProvider>
    </QueryProvider>
  )
}
