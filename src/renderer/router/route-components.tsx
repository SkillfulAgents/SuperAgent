import { Outlet } from '@tanstack/react-router'

/**
 * R1 SCAFFOLDING — placeholder route components.
 *
 * These exist only so the code-based route tree in `routes.ts` typechecks as
 * additive dead code. The tree is NOT mounted until R3, so none of these render
 * during R1/R2. Each is replaced with real wiring in the phase noted in its
 * comment; do not build features on these stubs.
 */

// Layout routes render an <Outlet/> so nested routes show once mounted (R3/R4).
export function RootLayout() {
  return <Outlet />
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
