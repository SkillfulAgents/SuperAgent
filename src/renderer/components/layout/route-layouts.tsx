import { lazyRouteComponent, Outlet } from '@tanstack/react-router'
import { Suspense, useCallback, useState, useEffect, useRef } from 'react'
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
import { SignupHandoffConsumer } from '@renderer/components/signup-handoff-consumer'
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
  // Latched on first open so the dialog stays mounted afterwards — unmounting
  // an open Radix dialog would skip its close animation and focus restore.
  const [searchEverOpened, setSearchEverOpened] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { data: globalSettings } = useSettings()
  const { isAuthMode, isAdmin, user } = useUser()
  const { open: searchOpen } = useSearch()
  const { identify } = useAnalyticsTracking()
  const hasAutoOpened = useRef(false)

  useEffect(() => {
    identify()
  }, [identify])

  useEffect(() => {
    if (searchOpen) setSearchEverOpened(true)
  }, [searchOpen])

  // Warm the search chunk once boot settles so the first cmd/ctrl-K opens
  // instantly instead of waiting on a network fetch. Off the critical path by
  // construction: idle callback (or a timer where unsupported, e.g. Safari).
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => {
        void SearchDialog.preload?.()
      })
      return () => window.cancelIdleCallback(id)
    }
    const id = window.setTimeout(() => {
      void SearchDialog.preload?.()
    }, 2500)
    return () => window.clearTimeout(id)
  }, [])

  // Load the wizard chunk BEFORE flipping wizardOpen: the wizard replaces
  // <Outlet/> outright, so suspending after the flip would blank the whole
  // window for the duration of the fetch (worst on first-boot onboarding over
  // slow networks). preload() resolves even on failure — the render then hits
  // lazyRouteComponent's reload-once / error path instead of never opening.
  const openWizard = useCallback(() => {
    void (GettingStartedWizard.preload?.() ?? Promise.resolve()).then(() => setWizardOpen(true))
  }, [])

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
      openWizard()
    } else if (!globalSettings.setupCompleted && isAdmin) {
      hasAutoOpened.current = true
      setWizardAgentOnly(false)
      openWizard()
    } else if (globalSettings.setupCompleted) {
      hasAutoOpened.current = true
      setWizardAgentOnly(true)
      openWizard()
    }
  }, [userSettings, globalSettings, isAuthMode, isAdmin, openWizard])

  return (
    <DialogProvider onOpenWizard={openWizard}>
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
              dialog stays off the boot graph until first opened, then stays
              mounted (closed) so Radix can play its exit animation. */}
          {searchOpen || searchEverOpened ? (
            <Suspense fallback={null}>
              <SearchDialog />
            </Suspense>
          ) : null}
          {/* Above the wizard ternary: the wizard replaces the outlet, so a
              consumer inside the outlet may never commit an effect. */}
          <SignupHandoffConsumer />
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
