import { createRouter } from '@tanstack/react-router'
import { createAppHistory } from './history'
import { routeTree, type RouterContext } from './routes'

/**
 * The router singleton. MUST be module-scope (never recreated in a component) so
 * the active route survives the AuthGate unmount/remount on login (§9) and so
 * IPC/SSE navigators (tray, OS notification clicks, `superagent://` deep links)
 * can call `router.navigate` directly.
 *
 * The context here is a PLACEHOLDER. The real `queryClient` and `user` are
 * injected at render by `<RouterProvider context={{ queryClient, user }}>` in
 * App.tsx (R3). The queryClient is injected (not imported) on purpose: there is
 * no module-singleton client — `query-client.ts` exports only a factory, and the
 * live instance is created by QueryClientProvider. Injecting QueryClientProvider's
 * instance is what lets loaders share the exact cache the hooks use.
 */
export const router = createRouter({
  routeTree,
  history: createAppHistory(),
  context: { queryClient: undefined, user: undefined } as unknown as RouterContext,
  defaultPreload: false, // streaming/SSE app — never prefetch-mount route loaders
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
