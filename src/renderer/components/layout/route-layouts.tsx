import { Outlet } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { DialogProvider } from '@renderer/context/dialog-context'
import { UpdateStatusProvider } from '@renderer/context/update-status-context'
import { UpdateToastNotifier } from '@renderer/components/update-toast-notifier'
import { AppSidebar } from '@renderer/components/layout/app-sidebar'
import { WindowControls } from '@renderer/components/layout/window-controls'
import { ContainerSetupHandler } from '@renderer/components/settings/container-setup-handler'
import { SidebarProvider, SidebarInset, useSidebar } from '@renderer/components/ui/sidebar'
import { TrayNavigationHandler } from '@renderer/components/tray-navigation-handler'
import { GlobalNotificationHandler } from '@renderer/components/notifications/global-notification-handler'
import { OnboardingProvider } from '@renderer/context/onboarding-context'
import { GettingStartedWizard } from '@renderer/components/wizard/getting-started-wizard'
import { SearchDialog } from '@renderer/components/search/search-dialog'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { useTheme } from '@renderer/hooks/use-theme'
import { useInsetRadius } from '@renderer/hooks/use-inset-radius'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { setRendererErrorReportingEnabled, setRendererErrorReportingUser } from '@renderer/lib/error-reporting'

/**
 * Root route: the always-mounted chrome (window controls, update toaster), the
 * app-level providers, and the wizard gate. Renders `<Outlet/>` for the app
 * shell. Decomposed from App.tsx's AppContent in R4.
 */
export function RootLayout() {
  useTheme()
  useInsetRadius()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardAgentOnly, setWizardAgentOnly] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { data: globalSettings } = useSettings()
  const { isAuthMode, isAdmin, user } = useUser()
  const { identify } = useAnalyticsTracking()
  const hasAutoOpened = useRef(false)

  useEffect(() => {
    identify()
  }, [identify])

  const shareErrorReports = globalSettings?.shareErrorReports
  useEffect(() => {
    if (shareErrorReports !== undefined) {
      setRendererErrorReportingEnabled(shareErrorReports !== false)
    }
  }, [shareErrorReports])

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
          {/* Real-time + native-nav handlers live HERE (root, above the
              shell⇄settings switch) so they stay mounted while /settings is open.
              Previously in AppShellLayout, which /settings replaces — so opening
              settings unmounted them, dropping the notification SSE + OS popups,
              the container-setup stream, and any tray navigate-to-agent IPC fired
              while in settings (review §4.1). All three only need useNavigate /
              useUser / useUserSettings, available at the root route. */}
          <TrayNavigationHandler>
            <GlobalNotificationHandler />
            <ContainerSetupHandler />
            <WindowControls />
            <UpdateToastNotifier />
            {/* Rendered here (inside the router) so it can use useNavigate — R11 §7.7. */}
            <SearchDialog />
            {wizardOpen ? (
              <GettingStartedWizard agentOnly={wizardAgentOnly} onClose={() => setWizardOpen(false)} />
            ) : (
              <Outlet />
            )}
          </TrayNavigationHandler>
        </OnboardingProvider>
      </UpdateStatusProvider>
    </DialogProvider>
  )
}

/**
 * Keeps Electron's traffic-light position synced to the sidebar collapsed state.
 * Must live inside SidebarProvider. Relocated from main-content.tsx in R4 so it
 * runs for every shell route, not just agent views.
 */
function SidebarCollapsedSync() {
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  useEffect(() => {
    if (!isElectron() || getPlatform() !== 'darwin') return
    window.electronAPI?.setSidebarCollapsed(sidebarState === 'collapsed' && !isFullScreen)
  }, [sidebarState, isFullScreen])
  return null
}

/**
 * App shell (pathless layout, mount-survival anchor #1): the sidebar + inset
 * that stays mounted as the `<Outlet/>` swaps between home, notifications, and an
 * agent. Settings is its own top-level route now (R12), a sibling of this shell,
 * so it replaces the whole shell via the router rather than a boolean here.
 * Decomposed from App.tsx's AppShell.
 */
export function AppShellLayout() {
  return (
    <SidebarProvider className="h-screen">
      <SidebarCollapsedSync />
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
