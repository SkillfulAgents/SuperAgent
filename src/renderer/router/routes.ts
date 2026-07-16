import { createRootRouteWithContext, createRoute, notFound, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type { UserContextValue } from '@renderer/context/user-context'
import { HttpError } from '@renderer/lib/api'
import { agentQuery } from '@renderer/hooks/query-options'
import { AgentNotFound, AgentLoadError } from './route-fallbacks'
import { lenient } from './zod-search'
import { chatSearchSchema, connectionsSearchSchema, homeSearchSchema, rootSearchSchema, settingsSearchSchema, settingsTabSchema } from './search-schemas'
import { HomePage } from '@renderer/components/home/home-page'
import { RootLayout, AppShellLayout } from '@renderer/components/layout/route-layouts'
import { NotificationsRoute } from '@renderer/components/layout/notifications-route'
import { NotificationDetailRoute } from '@renderer/components/layout/notification-detail-route'
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
 * Code-based route tree. No file-based codegen — the tree is small and fully
 * enumerated, kept in one reviewable file with identical type-safety.
 *
 * Param parsing uses the modern `params: { parse }` form (`parseParams` is
 * `@deprecated` in @tanstack/react-router@1.170.15).
 */

/** Router context injected at the root: the RouterProvider in App.tsx wires `user` at render time. */
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
  validateSearch: lenient(homeSearchSchema),
  component: HomePage,
})

export const notificationsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'notifications',
  component: NotificationsRoute,
})

export const notificationDetailRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'notifications/$id',
  params: { parse: (raw) => ({ id: z.string().min(1).parse(raw.id) }) },
  component: NotificationDetailRoute,
})

// ── AGENT LAYOUT: /agents/$slug — mount-survival anchor #2 (chat/SSE shell) ────
export const agentLayoutRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'agents/$slug',
  params: { parse: (raw) => ({ slug: z.string().min(1).parse(raw.slug) }) },
  // The SERVER is the sole access authority (no client beforeLoad fast-path —
  // the cached `my-agent-roles` is stale right after create-then-navigate, so a
  // client gate would falsely 404 a brand-new agent the user owns). The loader
  // warms the agent into the shared cache and maps the server's verdict: 403
  // (forbidden) and 404 (unknown) COLLAPSE to one ambiguous notFound
  // (anti-enumeration); 5xx/network → errorComponent.
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(agentQuery(params.slug))
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) throw notFound()
      throw err
    }
  },
  component: AgentShell,
  notFoundComponent: AgentNotFound,
  errorComponent: AgentLoadError,
})

export const agentHomeRoute = createRoute({
  // INDEX of /agents/$slug — the agent home. Every other sub-view is its own
  // sibling route, so this leaf is just AgentHome.
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
  // Accept any non-empty tab at the param layer; `beforeLoad` then gracefully
  // redirects an unknown tab to `/settings` instead of throwing a param-parse
  // error (a strict enum parse here hard-errors `/settings/garbage`).
  params: { parse: (raw) => ({ tab: z.string().min(1).parse(raw.tab) }) },
  beforeLoad: ({ params }) => {
    if (!settingsTabSchema.safeParse(params.tab).success) {
      // Preserve `?from=` so the close-target survives the normalization.
      throw redirect({ to: '/settings', search: (prev) => prev })
    }
  },
  component: SettingsTabRoute,
})

export const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([
    homeRoute,
    notificationsRoute,
    notificationDetailRoute,
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
