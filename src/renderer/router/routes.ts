import { createRootRouteWithContext, createRoute, lazyRouteComponent, notFound, redirect } from '@tanstack/react-router'
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

// Keep only the root shell and the default Home route on the boot graph. Route
// components below are fetched together with their dependencies only when a
// matching URL is entered; TanStack Router also knows how to preload these
// components during a route transition.
const NotificationsRoute = lazyRouteComponent(
  () => import('@renderer/components/layout/notifications-route'),
  'NotificationsRoute',
)
const NotificationDetailRoute = lazyRouteComponent(
  () => import('@renderer/components/layout/notification-detail-route'),
  'NotificationDetailRoute',
)
const ExploreRoute = lazyRouteComponent(
  () => import('@renderer/components/layout/explore-route'),
  'ExploreRoute',
)
const ExploreTemplateRoute = lazyRouteComponent(
  () => import('@renderer/components/layout/explore-route'),
  'ExploreTemplateRoute',
)
const ExploreCategoryRoute = lazyRouteComponent(
  () => import('@renderer/components/layout/explore-route'),
  'ExploreCategoryRoute',
)
const AgentShell = lazyRouteComponent(
  () => import('@renderer/components/layout/agent-shell'),
  'AgentShell',
)
const AgentHomeRoute = lazyRouteComponent(() => import('./lazy-routes/agent-home-route'), 'AgentHomeRoute')
const XAgentPermissionsRoute = lazyRouteComponent(() => import('./lazy-routes/x-agent-permissions-route'), 'XAgentPermissionsRoute')
const ApiLogsRoute = lazyRouteComponent(() => import('./lazy-routes/api-logs-route'), 'ApiLogsRoute')
const ChatRoute = lazyRouteComponent(() => import('./lazy-routes/chat-route'), 'ChatRoute')
const ConnectionsRoute = lazyRouteComponent(() => import('./lazy-routes/connections-route'), 'ConnectionsRoute')
const DashboardRoute = lazyRouteComponent(() => import('./lazy-routes/dashboard-route'), 'DashboardRoute')
const SecretsRoute = lazyRouteComponent(() => import('./lazy-routes/secrets-route'), 'SecretsRoute')
const SessionRoute = lazyRouteComponent(() => import('./lazy-routes/session-route'), 'SessionRoute')
const TaskRoute = lazyRouteComponent(() => import('./lazy-routes/task-route'), 'TaskRoute')
const WebhookRoute = lazyRouteComponent(() => import('./lazy-routes/webhook-route'), 'WebhookRoute')
const SettingsLayout = lazyRouteComponent(() => import('./settings-route-components'), 'SettingsLayout')
const SettingsIndexRoute = lazyRouteComponent(() => import('./settings-route-components'), 'SettingsIndexRoute')
const SettingsTabRoute = lazyRouteComponent(() => import('./settings-route-components'), 'SettingsTabRoute')

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

export const exploreRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'explore',
  component: ExploreRoute,
})

// Static `category` outranks the `$skillsetId/$templateSlug` pattern below, so
// this matches first despite both being two segments under /explore.
export const exploreCategoryRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'explore/category/$category',
  params: { parse: (raw) => ({ category: z.string().min(1).parse(raw.category) }) },
  component: ExploreCategoryRoute,
})

export const exploreTemplateRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: 'explore/$skillsetId/$templateSlug',
  params: {
    parse: (raw) => ({
      skillsetId: z.string().min(1).parse(raw.skillsetId),
      templateSlug: z.string().min(1).parse(raw.templateSlug),
    }),
  },
  component: ExploreTemplateRoute,
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

export const secretsRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'secrets',
  component: SecretsRoute,
})

export const xAgentPermissionsRoute = createRoute({
  getParentRoute: () => agentLayoutRoute,
  path: 'x-agent-permissions',
  component: XAgentPermissionsRoute,
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
    exploreRoute,
    exploreCategoryRoute,
    exploreTemplateRoute,
    agentLayoutRoute.addChildren([
      agentHomeRoute,
      sessionRoute,
      taskRoute,
      webhookRoute,
      chatRoute,
      dashboardRoute,
      apiLogsRoute,
      connectionsRoute,
      secretsRoute,
      xAgentPermissionsRoute,
    ]),
  ]),
  settingsRoute.addChildren([settingsIndexRoute, settingsTabRoute]),
])
