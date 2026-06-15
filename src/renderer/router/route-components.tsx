import { Outlet } from '@tanstack/react-router'
import { AppContent } from '@renderer/components/layout/app-content'
import { SelectionBridge } from './selection-bridge'

/**
 * Route components. R3 mounts the router: `RootLayout` now renders the
 * URL→Selection bridge plus the existing `AppContent`, so the router owns the
 * URL while the legacy SelectionContext switch still renders the UI. The rest
 * are R1 placeholder stubs, replaced in the phase noted in each comment — and
 * NOT rendered yet (RootLayout intentionally omits `<Outlet/>` in R3, so the
 * nested leaves match for the bridge but stay hidden behind AppContent).
 */

// R3: render the bridge + the existing app. No <Outlet/> until R4 begins
// decomposing AppContent into the nested shell routes.
export function RootLayout() {
  return (
    <>
      <SelectionBridge />
      <AppContent />
    </>
  )
}
export function AppShellLayout() {
  return <Outlet />
}
export function AgentShell() {
  return <Outlet />
}

function Placeholder({ name }: { name: string }) {
  return <div data-testid={`route-placeholder-${name}`} />
}

export function HomeRoute() {
  // R3 → real HomePage
  return <Placeholder name="home" />
}
export function NotificationsRoute() {
  // R13 → ContentShell header + NotificationsView
  return <Placeholder name="notifications" />
}
export function AgentHomeRoute() {
  // R10 → AgentHome (+ agent-scoped system-prompt/secrets dialogs)
  return <Placeholder name="agent-home" />
}
export function SessionRoute() {
  // R9 → FilePreviewProvider(sessionId) + SessionChatColumn
  return <Placeholder name="session" />
}
export function TaskRoute() {
  // R6 → ScheduledTaskView
  return <Placeholder name="task" />
}
export function WebhookRoute() {
  // R6 → WebhookTriggerView
  return <Placeholder name="webhook" />
}
export function ChatRoute() {
  // R8 → ChatIntegrationView
  return <Placeholder name="chat" />
}
export function DashboardRoute() {
  // R7 → DashboardView
  return <Placeholder name="dashboard" />
}
export function ApiLogsRoute() {
  // R5 → ApiLogsView
  return <Placeholder name="api-logs" />
}
export function ConnectionsRoute() {
  // R5 → ConnectionsView
  return <Placeholder name="connections" />
}
export function SettingsRoute() {
  // R12 → GlobalSettingsPage
  return <Placeholder name="settings" />
}
export function SettingsTabRoute() {
  // R12 → GlobalSettingsPage(initialSection=tab)
  return <Placeholder name="settings-tab" />
}
