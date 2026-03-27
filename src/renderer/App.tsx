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
import { useUserSettings } from './hooks/use-user-settings'
import { useTheme } from './hooks/use-theme'
import { useUser } from './context/user-context'
import { useAnalyticsTracking } from './context/analytics-context'
import { useSelection } from './context/selection-context'

const APPROVALS_GALLERY_QUERY_PARAM = 'approvals'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return (
    target.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select'
  )
}

function AppContent() {
  useTheme()
  const [wizardOpen, setWizardOpen] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { isAuthMode, isAdmin } = useUser()
  const { identify } = useAnalyticsTracking()
  const { clearSelection } = useSelection()
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return

      if (event.key.toLowerCase() === 'a' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()

        const url = new URL(window.location.href)
        const isOpen = url.searchParams.get('dev') === APPROVALS_GALLERY_QUERY_PARAM

        if (isOpen) {
          url.searchParams.delete('dev')
        } else {
          url.searchParams.set('dev', APPROVALS_GALLERY_QUERY_PARAM)
          clearSelection()
        }

        window.history.replaceState({}, '', url.toString())
        window.dispatchEvent(new PopStateEvent('popstate'))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [clearSelection])

  return (
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
