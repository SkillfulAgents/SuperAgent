import type { NavigateOptions } from '@tanstack/react-router'

/**
 * Discriminated union describing what is currently shown for the selected agent
 * (exactly one view at a time — mutual exclusion by construction). A pure
 * route/codec type with no React dependency, so it lives next to the
 * encode/decode that consume it.
 */
export type AgentView =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'webhook'; id: string }
  | { kind: 'chat'; integrationId: string; sessionId?: string }
  | { kind: 'dashboard'; slug: string }
  | { kind: 'apiLogs' }
  | { kind: 'secrets' }
  | {
      kind: 'connections'
      /**
       * Open the connections page with this row's detail view shown. `source`
       * is where it was opened from — it decides the breadcrumb trail and where
       * Back leads (agent home vs. the connections list).
       */
      detail?: { rowKey: string; source: 'home' | 'list'; view?: 'logs' }
    }
  | { kind: 'notifications' }

/**
 * The single source of truth mapping the app's navigation state
 * (`{ selectedAgentSlug, view }`) to/from a URL. `encodeLocation` and
 * `decodeLocation` are inverses (proven by route-state.test.ts), so the read
 * side (`useRouteLocation`) and every navigation call site share one mapping and
 * cannot drift.
 */
export interface AppLocation {
  selectedAgentSlug: string | null
  view: AgentView
}

/**
 * A snapshot of the deepest matched route, as the inverse input to
 * `decodeLocation`. `to` is the full path template of the leaf match (e.g.
 * `/agents/$slug/sessions/$sessionId`) — exactly the `to` value `encodeLocation`
 * emits, which is also what TanStack exposes as a match's full path.
 */
export interface RouteSnapshot {
  to: string
  params: Record<string, string | undefined>
  search: Record<string, unknown>
}

function assertNever(x: never): never {
  throw new Error(`Unhandled AgentView kind: ${JSON.stringify(x)}`)
}

/** AppLocation → a typed navigate target. The ONE place that maps a view to a URL. */
export function encodeLocation(loc: AppLocation): NavigateOptions {
  const slug = loc.selectedAgentSlug
  const view = loc.view

  // Notifications is a globally-scoped view: its URL never carries an agent slug
  // (navigating to it drops agent scope).
  if (view.kind === 'notifications') return { to: '/notifications' }

  // The only other slug-less view we model is the global home.
  if (slug === null) return { to: '/' }

  switch (view.kind) {
    case 'home':
      return { to: '/agents/$slug', params: { slug } }
    case 'session':
      return { to: '/agents/$slug/sessions/$sessionId', params: { slug, sessionId: view.id } }
    case 'task':
      return { to: '/agents/$slug/tasks/$taskId', params: { slug, taskId: view.id } }
    case 'webhook':
      return { to: '/agents/$slug/webhooks/$webhookId', params: { slug, webhookId: view.id } }
    case 'chat':
      return {
        to: '/agents/$slug/chat/$integrationId',
        params: { slug, integrationId: view.integrationId },
        search: view.sessionId ? { session: view.sessionId } : {},
      }
    case 'dashboard':
      return { to: '/agents/$slug/dashboards/$dashSlug', params: { slug, dashSlug: view.slug } }
    case 'apiLogs':
      return { to: '/agents/$slug/api-logs', params: { slug } }
    case 'secrets':
      return { to: '/agents/$slug/secrets', params: { slug } }
    case 'connections':
      return {
        to: '/agents/$slug/connections',
        params: { slug },
        search: view.detail
          ? {
              detail: view.detail.rowKey,
              source: view.detail.source,
              ...(view.detail.view ? { connectionView: view.detail.view } : {}),
            }
          : {},
      }
    default:
      return assertNever(view)
  }
}

/** The inverse of `encodeLocation`: a matched route → AppLocation. */
export function decodeLocation(snap: RouteSnapshot): AppLocation {
  const p = snap.params
  const search = snap.search
  // Index routes report a trailing-slash fullPath (the agent home is
  // '/agents/$slug/', verified against the built route tree); normalize it away
  // so the templates below stay canonical (root '/' is preserved).
  const to = snap.to.length > 1 && snap.to.endsWith('/') ? snap.to.slice(0, -1) : snap.to

  switch (to) {
    case '/':
      return { selectedAgentSlug: null, view: { kind: 'home' } }
    case '/notifications':
      return { selectedAgentSlug: null, view: { kind: 'notifications' } }
    case '/agents/$slug':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'home' } }
    case '/agents/$slug/sessions/$sessionId':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'session', id: p.sessionId ?? '' } }
    case '/agents/$slug/tasks/$taskId':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'task', id: p.taskId ?? '' } }
    case '/agents/$slug/webhooks/$webhookId':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'webhook', id: p.webhookId ?? '' } }
    case '/agents/$slug/chat/$integrationId': {
      const session = typeof search.session === 'string' ? search.session : undefined
      return {
        selectedAgentSlug: p.slug ?? null,
        view: { kind: 'chat', integrationId: p.integrationId ?? '', ...(session ? { sessionId: session } : {}) },
      }
    }
    case '/agents/$slug/dashboards/$dashSlug':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'dashboard', slug: p.dashSlug ?? '' } }
    case '/agents/$slug/api-logs':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'apiLogs' } }
    case '/agents/$slug/secrets':
      return { selectedAgentSlug: p.slug ?? null, view: { kind: 'secrets' } }
    case '/agents/$slug/connections': {
      const detail = typeof search.detail === 'string' ? search.detail : undefined
      const source = search.source === 'home' || search.source === 'list' ? search.source : undefined
      const detailView = search.connectionView === 'logs' ? 'logs' : undefined
      return {
        selectedAgentSlug: p.slug ?? null,
        view: {
          kind: 'connections',
          ...(detail && source
            ? { detail: { rowKey: detail, source, ...(detailView ? { view: detailView } : {}) } }
            : {}),
        },
      }
    }
    default:
      // Unknown / non-app-shell routes (e.g. /settings) are not AgentView state;
      // they have their own top-level routes. Degrade to the global home.
      return { selectedAgentSlug: null, view: { kind: 'home' } }
  }
}
