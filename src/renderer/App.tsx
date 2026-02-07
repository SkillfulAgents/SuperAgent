import { useState, useEffect, useRef } from 'react'
import { QueryProvider } from './providers/query-provider'
import { SelectionProvider } from './context/selection-context'
import { DialogProvider } from './context/dialog-context'
import { AppSidebar } from './components/layout/app-sidebar'
import { MainContent } from './components/layout/main-content'
import { SidebarProvider, SidebarInset } from './components/ui/sidebar'
import { TrayNavigationHandler } from './components/tray-navigation-handler'
import { GlobalNotificationHandler } from './components/notifications/global-notification-handler'
import { GettingStartedWizard } from './components/wizard/getting-started-wizard'
import { useSettings } from './hooks/use-settings'

function AppContent() {
  const [wizardOpen, setWizardOpen] = useState(false)
  const { data: settings } = useSettings()
  const hasAutoOpened = useRef(false)

  // Auto-open wizard on first launch
  useEffect(() => {
    if (settings && !settings.setupCompleted && !hasAutoOpened.current) {
      hasAutoOpened.current = true
      setWizardOpen(true)
    }
  }, [settings])

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
      <SelectionProvider>
        <AppContent />
      </SelectionProvider>
    </QueryProvider>
  )
}
