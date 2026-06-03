import { useState, useEffect, useRef } from 'react'
import { QueryProvider } from './providers/query-provider'
import { UserProvider } from './context/user-context'
import { AnalyticsProvider } from './context/analytics-context'
import { AuthGate } from './components/auth/auth-gate'
import { SelectionProvider } from './context/selection-context'
import { ConnectivityProvider } from './context/connectivity-context'
import { DialogProvider, useDialogs } from './context/dialog-context'
import { UpdateStatusProvider } from './context/update-status-context'
import { UpdateToastNotifier } from './components/update-toast-notifier'
import { DraftsProvider } from './context/drafts-context'
import { SearchProvider } from './context/search-context'
import { AppSidebar } from './components/layout/app-sidebar'
import { MainContent } from './components/layout/main-content'
import { WindowControls } from './components/layout/window-controls'
import { GlobalSettingsPage } from './components/settings/global-settings-page'
import { ContainerSetupHandler } from './components/settings/container-setup-handler'
import { SidebarProvider, SidebarInset } from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { TrayNavigationHandler } from './components/tray-navigation-handler'
import { GlobalNotificationHandler } from './components/notifications/global-notification-handler'
import { OnboardingProvider } from './context/onboarding-context'
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
  const [wizardAgentOnly, setWizardAgentOnly] = useState(false)
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

  useEffect(() => {
    if (hasAutoOpened.current) return
    if (!userSettings || !globalSettings) return

    if (userSettings.setupCompleted) return

    if (!isAuthMode) {
      hasAutoOpened.current = true
      setWizardAgentOnly(false)
      setWizardOpen(true)
    } else if (!globalSettings.setupCompleted && isAdmin) {
      hasAutoOpened.current = true
      setWizardAgentOnly(false)
      setWizardOpen(true)
    } else if (globalSettings.setupCompleted) {
      hasAutoOpened.current = true
      setWizardAgentOnly(true)
      setWizardOpen(true)
    }
  }, [userSettings, globalSettings, isAuthMode, isAdmin])

  return (
    <DialogProvider onOpenWizard={() => setWizardOpen(true)}>
      <UpdateStatusProvider>
        <OnboardingProvider>
          <WindowControls />
          <UpdateToastNotifier />
          {wizardOpen ? (
            <GettingStartedWizard agentOnly={wizardAgentOnly} onClose={() => setWizardOpen(false)} />
          ) : (
            <AppShell />
          )}
        </OnboardingProvider>
      </UpdateStatusProvider>
    </DialogProvider>
  )
}

function AppShell() {
  const { settingsOpen, setSettingsOpen, settingsTab, openWizard } = useDialogs()

  return (
    <TrayNavigationHandler>
      <GlobalNotificationHandler />
      <ContainerSetupHandler />
      {settingsOpen ? (
        <GlobalSettingsPage
          onClose={() => setSettingsOpen(false)}
          onOpenWizard={openWizard}
          initialSection={settingsTab}
        />
      ) : (
        <SidebarProvider className="h-screen">
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <MainContent />
          </SidebarInset>
        </SidebarProvider>
      )}
    </TrayNavigationHandler>
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
                  <SearchProvider>
                    <ErrorBoundary>
                      <AppContent />
                      <Toaster />
                    </ErrorBoundary>
                  </SearchProvider>
                </DraftsProvider>
              </ConnectivityProvider>
            </SelectionProvider>
          </AnalyticsProvider>
        </AuthGate>
      </UserProvider>
    </QueryProvider>
  )
}
