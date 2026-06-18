// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  RouterProvider,
} from '@tanstack/react-router'
import { lenient } from './zod-search'
import { settingsSearchSchema, settingsTabSchema } from './search-schemas'

/**
 * Pins `settingsTabRoute.beforeLoad` (routes.ts:173) in isolation: an UNKNOWN
 * `$tab` redirects to `/settings` while PRESERVING `?from=` (the close-target),
 * and a KNOWN tab is a no-op (the tab leaf renders, no redirect).
 *
 * The e2e (settings.spec) only checks that `/settings/garbage` lands on
 * `/settings`; it never seeds a `?from` nor asserts it survives, so the
 * load-bearing `search: (prev) => prev` updater (routes.ts:176) is untested
 * there. A memory-history router rooted at a faithful settings subtree pins both
 * the redirect AND the `?from` preservation deterministically.
 *
 * The route definitions below mirror routes.ts exactly (same path/param/search
 * config and the same `beforeLoad`); the leaf components are inert stubs because
 * this test exercises routing, not the settings page.
 */

// Minimal RouterContext: the settings subtree never touches `queryClient`/`user`,
// so a bare object satisfies `createRootRouteWithContext` at the type boundary.
const rootRoute = createRootRouteWithContext<Record<string, never>>()({})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  validateSearch: lenient(settingsSearchSchema),
})

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: () => <div data-testid="settings-index">settings-index</div>,
})

const settingsTabRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '$tab',
  params: { parse: (raw: { tab: string }) => ({ tab: settingsTabParamParse(raw.tab) }) },
  beforeLoad: ({ params }) => {
    if (!settingsTabSchema.safeParse(params.tab).success) {
      // Mirrors routes.ts:176 — preserve `?from=` across the normalization.
      throw redirect({ to: '/settings', search: (prev) => prev })
    }
  },
  component: () => <div data-testid="settings-tab">settings-tab</div>,
})

// routes.ts uses `z.string().min(1).parse(raw.tab)`; inlined here so the test owns
// no extra import surface and the param layer accepts ANY non-empty tab (the
// graceful redirect — not a strict enum parse — is what handles an unknown tab).
function settingsTabParamParse(tab: string): string {
  if (typeof tab !== 'string' || tab.length < 1) throw new Error('invalid tab')
  return tab
}

const routeTree = rootRoute.addChildren([settingsRoute.addChildren([settingsIndexRoute, settingsTabRoute])])

function makeRouter(initialEntry: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: {},
  })
}

describe('settingsTabRoute.beforeLoad', () => {
  it('redirects an unknown tab to /settings and preserves ?from', async () => {
    const router = makeRouter('/settings/totally-not-a-tab?from=%2Fagents%2Ffoo')
    render(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings')
    })
    // The load-bearing `search: (prev) => prev` — the close-target must survive.
    expect((router.state.location.search as { from?: string }).from).toBe('/agents/foo')
  })

  it('leaves a known tab in place (no redirect, tab leaf renders)', async () => {
    // `runtime` is a real SETTINGS_TABS member (search-schemas.ts).
    const router = makeRouter('/settings/runtime')
    const { findByTestId, queryByTestId } = render(<RouterProvider router={router} />)

    await findByTestId('settings-tab')
    expect(router.state.location.pathname).toBe('/settings/runtime')
    expect(queryByTestId('settings-index')).toBeNull()
  })
})
