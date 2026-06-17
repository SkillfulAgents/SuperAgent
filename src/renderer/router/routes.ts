import { createRootRouteWithContext, createRoute } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type { UserContextValue } from '@renderer/context/user-context'
import { lenient } from './zod-search'
import { chatSearchSchema, connectionsSearchSchema, rootSearchSchema, settingsSearchSchema, settingsTabSchema } from './search-schemas'
import { HomePage } from '@renderer/components/home/home-page'
import { RootLayout, AppShellLayout } from '@renderer/components/layout/route-layouts'
import { NotificationsRoute } from '@renderer/components/layout/notifications-route'
import { AgentShell } from '@renderer/components/layout/agent-shell'
import {
  AgentHomeRoute,
  ApiLogsRoute,
  ChatRoute,
  ConnectionsRoute,
  DashboardRoute,
  SessionRoute,
  SettingsLayout,
  SettingsIndexRoute,
  SettingsTabRoute,
  TaskRoute,
  WebhookRoute,
} from './route-components'

/**
 * Code-based route tree (migration plan §4.3). No file-based codegen — the tree
 * is small and fully enumerated, kept in one reviewable file with identical
 * type-safety. R1 builds the structure only: NO loaders, NO access control, NO
 * not-found/error components — those land in R4 (AgentShell) and R15 (loaders).
 *
 * Param parsing uses the modern `params: { parse }` form (`parseParams` is
 * `@deprecated` in @tanstack/react-router@1.170.15).
 */

/** Router context injected at the root: the RouterProvider in App.tsx wires `user` at render time (R2/R3). */
export interface RouterContext {
  queryClient: QueryClient
  user: UserContextValue
}

// ── ROOT: always-mounted, route-independent shell ────────────────────────────
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: lenient(rootSearchSchema),
  component: RootLayout,
})

// ── APP-SHELL: pathless layout (sidebar + inset) — mount-survival anchor #1 ───
export const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app-shell',
  component: AppShellLayout,
})

export const homeRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  component: HomePage,
})

export const notificationsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'notifications',
  component: NotificationsRoute,
})

// ── AGENT LAYOUT: /agents/$slug — mount-survival anchor #2 (chat/SSE shell) ────
export const agentLayoutRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'agents/$slug',
  params: { parse: (raw) => ({ slug: z.string().min(1).parse(raw.slug) }) },
  component: AgentShell,
})

export const agentHomeRoute = createRoute({
  // INDEX of /agents/$slug — the agent home (R10). Every other sub-view is its
  // own sibling route, so this leaf is just AgentHome.
  getParentRoute: () => agentLayoutRoute,
  path: '/',
  component: AgentHomeRoute,
})

export const sessionRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'sessions/$sessionId',
  params: { parse: (raw) => ({ sessionId: z.string().min(1).parse(raw.sessionId) }) },
  component: SessionRoute,
})

export const taskRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'tasks/$taskId',
  params: { parse: (raw) => ({ taskId: z.string().min(1).parse(raw.taskId) }) },
  component: TaskRoute,
})

export const webhookRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'webhooks/$webhookId',
  params: { parse: (raw) => ({ webhookId: z.string().min(1).parse(raw.webhookId) }) },
  component: WebhookRoute,
})

export const chatRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'chat/$integrationId',
  params: { parse: (raw) => ({ integrationId: z.string().min(1).parse(raw.integrationId) }) },
  validateSearch: lenient(chatSearchSchema),
  component: ChatRoute,
})

export const dashboardRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'dashboards/$dashSlug',
  params: { parse: (raw) => ({ dashSlug: z.string().min(1).parse(raw.dashSlug) }) },
  component: DashboardRoute,
})

export const apiLogsRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'api-logs',
  component: ApiLogsRoute,
})

export const connectionsRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'connections',
  validateSearch: lenient(connectionsSearchSchema),
  component: ConnectionsRoute,
})

// ── SETTINGS: SIBLING of app-shell → replaces the whole shell (App.tsx) ───────
// LAYOUT (just an <Outlet/>): so the `$tab` child renders. `?from=` close-target
// (open-redirect-safe) lives here and is inherited by both children.
export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  validateSearch: lenient(settingsSearchSchema),
  component: SettingsLayout,
})

export const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: SettingsIndexRoute,
})

export const settingsTabRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '$tab',
  // Strict tab validation against the enum (a junk `/settings/garbage` throws).
  // The graceful junk→/settings redirect is a deferred R12 refinement.
  params: { parse: (raw) => ({ tab: settingsTabSchema.parse(raw.tab) }) },
  component: SettingsTabRoute,
})

export const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([
    homeRoute,
    notificationsRoute,
    agentLayoutRoute.addChildren([
      agentHomeRoute,
      sessionRoute,
      taskRoute,
      webhookRoute,
      chatRoute,
      dashboardRoute,
      apiLogsRoute,
      connectionsRoute,
    ]),
  ]),
  settingsRoute.addChildren([settingsIndexRoute, settingsTabRoute]),
])
