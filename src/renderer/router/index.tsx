import { createRouter } from '@tanstack/react-router'
import { createAppHistory } from './history'
import { routeTree, type RouterContext } from './routes'
import { RouteNotFound, RouteError } from './route-fallbacks'

/**
 * The router singleton. MUST be module-scope (never recreated in a component) so
 * the active route survives the AuthGate unmount/remount on login and so
 * IPC/SSE navigators (tray, OS notification clicks, `superagent://` deep links)
 * can call `router.navigate` directly.
 *
 * The context here is a PLACEHOLDER. The real `queryClient` and `user` are
 * injected at render by `<RouterProvider context={{ queryClient, user }}>` in
 * App.tsx. The queryClient is injected (not imported) on purpose: there is
 * no module-singleton client — `query-client.ts` exports only a factory, and the
 * live instance is created by QueryClientProvider. Injecting QueryClientProvider's
 * instance is what lets loaders share the exact cache the hooks use.
 */
export const router = createRouter({
  routeTree,
  history: createAppHistory(),
  context: { queryClient: undefined, user: undefined } as unknown as RouterContext,
  defaultPreload: false, // streaming/SSE app — never prefetch-mount route loaders
  // NB: structural sharing is applied locally on useRouteLocation's useRouterState
  // selector rather than globally here — a global default would
  // force an explicit `structuralSharing` on every `useSearch({ strict: false })`.
  // Styled app-level fallbacks for any unmatched URL / unexpected throw on a
  // route without its own fallback. Route-level fallbacks (the
  // agent layout's notFound/error) still take precedence.
  defaultNotFoundComponent: RouteNotFound,
  defaultErrorComponent: RouteError,
})

/**
 * Navigation conventions, so the call-site mix doesn't regrow:
 *  - Declarative links → <AppLink> (real <a>, cmd-click/middle-click work).
 *  - Inside React components → the useNavigate() hook.
 *  - Non-React module code only (IPC/SSE/tray handlers, the AppLink click
 *    interceptor) → this `router` singleton's `router.navigate`.
 * Build URL targets via encodeLocation (route-state.ts) — the single view→URL map.
 */

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
