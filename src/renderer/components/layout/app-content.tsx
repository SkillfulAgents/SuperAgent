import { useState, useEffect, useRef } from 'react'
import { DialogProvider, useDialogs } from '@renderer/context/dialog-context'
import { UpdateStatusProvider } from '@renderer/context/update-status-context'
import { UpdateToastNotifier } from '@renderer/components/update-toast-notifier'
import { AppSidebar } from '@renderer/components/layout/app-sidebar'
import { MainContent } from '@renderer/components/layout/main-content'
import { WindowControls } from '@renderer/components/layout/window-controls'
import { GlobalSettingsPage } from '@renderer/components/settings/global-settings-page'
import { ContainerSetupHandler } from '@renderer/components/settings/container-setup-handler'
import { SidebarProvider, SidebarInset } from '@renderer/components/ui/sidebar'
import { TrayNavigationHandler } from '@renderer/components/tray-navigation-handler'
import { GlobalNotificationHandler } from '@renderer/components/notifications/global-notification-handler'
import { OnboardingProvider } from '@renderer/context/onboarding-context'
import { GettingStartedWizard } from '@renderer/components/wizard/getting-started-wizard'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { useTheme } from '@renderer/hooks/use-theme'
import { useInsetRadius } from '@renderer/hooks/use-inset-radius'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { setRendererErrorReportingEnabled, setRendererErrorReportingUser } from '@renderer/lib/error-reporting'

/**
 * The existing app UI (window chrome, wizard gate, sidebar + main content, and
 * the global settings page). Rendered by the router's root route (RootLayout) so
 * it sits INSIDE RouterProvider — this is what lets its descendants adopt router
 * hooks (`<AppLink>`, `useNavigate`) as views convert in R5+.
 *
 * Extracted verbatim from App.tsx in R3 to keep `route-components.tsx` from
 * importing the app entry (which would create a cycle). It dissolves into
 * dedicated route components across R4–R13.
 */
export function AppContent() {
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
