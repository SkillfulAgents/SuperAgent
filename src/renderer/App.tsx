import { QueryProvider } from './providers/query-provider'
import { SelectionProvider } from './context/selection-context'
import { AppSidebar } from './components/layout/app-sidebar'
import { MainContent } from './components/layout/main-content'
import { SidebarProvider, SidebarInset } from './components/ui/sidebar'
import { TrayNavigationHandler } from './components/tray-navigation-handler'
import { GlobalNotificationHandler } from './components/notifications/global-notification-handler'

export default function App() {
  return (
    <QueryProvider>
      <SelectionProvider>
        <TrayNavigationHandler>
          <GlobalNotificationHandler />
          <SidebarProvider className="h-screen">
            <AppSidebar />
            <SidebarInset className="min-w-0 h-full">
              <MainContent />
            </SidebarInset>
          </SidebarProvider>
        </TrayNavigationHandler>
      </SelectionProvider>
    </QueryProvider>
  )
}
