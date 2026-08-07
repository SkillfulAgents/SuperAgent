import { lazyRouteComponent, Outlet } from '@tanstack/react-router'
import { Suspense, useState, useEffect, useRef } from 'react'
import { DialogProvider } from '@renderer/context/dialog-context'
import { UpdateStatusProvider } from '@renderer/context/update-status-context'
import { UpdateToastNotifier } from '@renderer/components/update-toast-notifier'
import { AppSidebar } from '@renderer/components/layout/app-sidebar'
import { WindowControls } from '@renderer/components/layout/window-controls'
import { ContainerSetupHandler } from '@renderer/components/settings/container-setup-handler'
import { SidebarProvider, SidebarInset } from '@renderer/components/ui/sidebar'
import { CmdHintProvider } from '@renderer/context/cmd-hint-context'
import { MenuCommandHandler } from '@renderer/components/menu-command-handler'
import { PackageImportHandler } from '@renderer/components/package-import-handler'
import { HistoryNavigationHandler } from '@renderer/components/history-navigation-handler'
import { GlobalNotificationHandler } from '@renderer/components/notifications/global-notification-handler'
import { OnboardingProvider } from '@renderer/context/onboarding-context'
import { useSearch } from '@renderer/context/search-context'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { useTheme } from '@renderer/hooks/use-theme'
import { useInsetRadius } from '@renderer/hooks/use-inset-radius'
import { useKeyboardViewport } from '@renderer/hooks/use-keyboard-viewport'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { useDocumentTitle } from '@renderer/hooks/use-document-title'
import { setRendererErrorReportingEnabled, setRendererErrorReportingUser } from '@renderer/lib/error-reporting'

const SearchDialog = lazyRouteComponent(
  () => import('@renderer/components/search/search-dialog'),
  'SearchDialog',
)
const GettingStartedWizard = lazyRouteComponent(
  () => import('@renderer/components/wizard/getting-started-wizard'),
  'GettingStartedWizard',
)

/**
 * Root route: the always-mounted chrome (window controls, update toaster), the
 * app-level providers, and the wizard gate. Renders `<Outlet/>` for the app
 * shell.
 */
export function RootLayout() {
  useTheme()
  useInsetRadius()
  useDocumentTitle()
  useKeyboardViewport()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardAgentOnly, setWizardAgentOnly] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { data: globalSettings } = useSettings()
  const { isAuthMode, isAdmin, user } = useUser()
  const { open: searchOpen } = useSearch()
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
              The /settings route replaces the whole shell, so handlers mounted
              inside the shell would unmount on open — dropping the notification
              SSE + OS popups, the container-setup stream, and any native
              menu/tray command fired while in settings. MenuCommandHandler also
              drains the window-closed menu-command queue (SUP-264). All only need
              useNavigate / useDialogs / useUser / useUserSettings — available at
              the root route. */}
          <MenuCommandHandler />
          <PackageImportHandler />
          <HistoryNavigationHandler />
          <GlobalNotificationHandler />
          <ContainerSetupHandler />
          <WindowControls />
          <UpdateToastNotifier />
          {/* Rendered here (inside the router) so it can use useNavigate. The
              closed dialog stays off the boot graph entirely. */}
          {searchOpen ? (
            <Suspense fallback={null}>
              <SearchDialog />
            </Suspense>
          ) : null}
          {wizardOpen ? (
            <Suspense fallback={null}>
              <GettingStartedWizard agentOnly={wizardAgentOnly} onClose={() => setWizardOpen(false)} />
            </Suspense>
          ) : (
            <Outlet />
          )}
        </OnboardingProvider>
      </UpdateStatusProvider>
    </DialogProvider>
  )
}

/**
 * App shell (pathless layout, mount-survival anchor #1): the sidebar + inset
 * that stays mounted as the `<Outlet/>` swaps between home, notifications, and an
 * agent. Settings is a top-level route, a sibling of this shell, so it replaces
 * the whole shell via the router rather than a boolean here.
 */
export function AppShellLayout() {
  return (
    <CmdHintProvider>
      <SidebarProvider className="h-screen">
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </CmdHintProvider>
  )
}
