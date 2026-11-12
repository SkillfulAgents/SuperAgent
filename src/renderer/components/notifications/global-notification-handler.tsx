import { readPlatformNotifications } from '@renderer/lib/platform-notification-read-cache'
import { notificationChangeSchema } from '@shared/lib/notifications/notification-change-schema'
import { readNotifications, noteNotificationChange, invalidateNotificationCaches, notificationClientId } from '@renderer/lib/notification-read-cache'
import { collaborationEventSchema } from '@shared/lib/agent-members-schema'
import { resolveRouteAgentId } from '@renderer/hooks/use-agents'
import type { ApiAgent } from '@shared/lib/types/api'
/**
 * Global Notification Handler
 *
 * Connects to the global SSE stream and handles:
 * - OS notifications (gated by session focus — actionable types also fire
 *   when the window is unfocused at the OS level)
 * - OS notification action button dispatch (Approve/Deny → API)
 * - Session state changes (active/idle) - updates sidebar
 * - Agent status changes (running/stopped) - updates agent list
 * - Scheduled task updates - updates task list
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { getApiBaseUrl, isElectron } from '@renderer/lib/env'
import { apiFetch } from '@renderer/lib/api'
import { showOSNotification } from '@renderer/lib/os-notifications'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
import { usePlatformUnreadCount } from '@renderer/hooks/use-platform-notifications'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { setMountWarning } from '@renderer/hooks/use-mount-warnings'
import { WEBHOOK_RELAY_QUERY_KEY } from '@renderer/hooks/use-webhook-relay'
import {
  agentDetailQueryKeys,
  applyDashboardRuntimeStatus,
  applySessionActivityStatus,
  invalidateAgentArtifacts,
  invalidateAgentWidgets,
  invalidateAutomationSessionLists,
  markDashboardScreenshotReady,
  patchAgentWidget,
  sessionListMembership,
  updateAgentRuntimeCache,
  type SessionStatusPatch,
} from '@renderer/lib/agent-cache'
import { createInvalidationCoalescer } from '@renderer/lib/invalidation-coalescer'
import type { UserSettingsData } from '@shared/lib/services/user-settings-service'
import {
  NotificationActionContextSchema,
  NotificationEventSchema,
  NotificationActionsArraySchema,
  NotificationMetadataSchema,
} from '@shared/lib/notifications/notification-action-schema'
import {
  supportsDeclarativeWebPush,
  revalidatePushSubscription,
} from '@renderer/lib/push-notifications'
import {
  isNotificationTypeEnabled as isTypeEnabledInPreferences,
  USER_ACTIONABLE_NOTIFICATION_TYPES,
} from '@shared/lib/notifications/notification-preferences'
import { useRenderTracker } from '@renderer/lib/perf'
import type { RuntimeReadiness } from '@shared/lib/container/types'
import type { RuntimeStatusResponse } from '@renderer/hooks/use-runtime-status'
import type { GlobalSettingsResponse } from '@renderer/hooks/use-settings'
import { TODOS_QUERY_KEY } from '@renderer/hooks/use-todos'
import { reconnectDelayMs, watchStreamLiveness } from '@renderer/lib/stream-liveness'

// Queries whose fetch runs an LLM completion server-side. Everything else is
// refetched wholesale each time the stream says `connected`.
const EXPENSIVE_QUERY_KEYS = new Set<unknown>([
  'agent-template-publish-info',
  'agent-template-pr-info',
  'skill-publish-info',
  'skill-pr-info',
])

export function isRefetchableAfterOutage(query: { queryKey: readonly unknown[] }): boolean {
  return !EXPENSIVE_QUERY_KEYS.has(query.queryKey[0])
}

// Optimistic status echo per session lifecycle event. Deliberately exhaustive
// with NO fallback: an event type added to the lifecycle case group without a
// row here gets invalidations but no echo, forcing its semantics to be decided
// explicitly — a wrong optimistic stamp is worse than none. Idle/error also
// clear the awaiting flag: turn teardown resets it server-side WITHOUT
// broadcasting session_input_provided, so an idle echo that left it cached
// would strand the orange dot until the refetch.
const SESSION_LIFECYCLE_ECHO = {
  session_active: { isActive: true },
  // An idle session can be awaiting on a call parked on its own card, so this
  // asserts awaiting only; session_active owns the active flag.
  session_awaiting_input: { isAwaitingInput: true },
  session_input_provided: { isAwaitingInput: false },
  session_idle: { isActive: false, isAwaitingInput: false },
  session_error: { isActive: false, isAwaitingInput: false },
} satisfies Record<string, SessionStatusPatch>

// Session events arrive in bursts (active, awaiting, idle within one turn) and
// from every agent in the workspace — on the shared e2e server, from every
// parallel worker too. The echo above patches the caches at once, so the
// list-wide refetches behind it only confirm: they run once per burst rather
// than once per event, since each full agents-list refetch updates every
// subscriber of that list in every open tab.
const SESSION_CONFIRMATION_DELAY_MS = 500

function isNotificationTypeEnabled(
  settings: UserSettingsData | undefined,
  notificationType: string
): boolean {
  const n = settings?.notifications
  if (n === undefined) return true // no settings loaded yet → allow
  // Type→toggle mapping is shared with the server-side gates
  // (notification-preferences.ts) so the two can never drift.
  return isTypeEnabledInPreferences(n, notificationType)
}

export function GlobalNotificationHandler() {
  useRenderTracker('GlobalNotificationHandler')
  const queryClient = useQueryClient()
  const { view, selectedAgentSlug } = useRouteLocation()
  const navigate = useNavigate()
  const selectedSessionId = view.kind === 'session' ? view.id : null
  const { data: unreadData } = useUnreadNotificationCount()
  const { data: platformUnreadData } = usePlatformUnreadCount()
  const { data: userSettings } = useUserSettings()
  const { canAccessAgent } = useUser()
  const selectedAgentRef = useRef(selectedAgentSlug)
  selectedAgentRef.current = selectedAgentSlug
  // Use refs to avoid recreating EventSource when reactive values change
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId
  const userSettingsRef = useRef(userSettings)
  userSettingsRef.current = userSettings
  const canAccessAgentRef = useRef(canAccessAgent)
  canAccessAgentRef.current = canAccessAgent
  const [reconnectKey, setReconnectKey] = useState(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const streamRef = useRef<EventSource | null>(null)

  // Sync dock badge count with unread notifications (macOS Electron only)
  useEffect(() => {
    if (isElectron() && window.electronAPI?.setBadgeCount) {
      const count = (unreadData?.count ?? 0) + (platformUnreadData?.count ?? 0)
      window.electronAPI.setBadgeCount(count)
    }
  }, [unreadData?.count, platformUnreadData?.count])

  // Dispatch a single notification interaction event. Shared between live
  // events (onNotificationEvent) and queued events flushed on mount.
  // Validates both the event envelope and the embedded action context with
  // Zod — a malicious / corrupted payload (e.g. crafted SSE injection) is
  // dropped at this boundary instead of trusted as-is.
  const dispatchNotificationEvent = useCallback((rawEvent: unknown) => {
    const eventResult = NotificationEventSchema.safeParse(rawEvent)
    if (!eventResult.success) return
    const event = eventResult.data

    // Mark the DB notification as read on ANY interaction (body click or
    // action button) — otherwise the unread badge keeps counting events
    // the user has clearly seen and acted on. Uses the loose metadata
    // schema so this works regardless of `kind`.
    const metaResult = NotificationMetadataSchema.safeParse(event.context)
    const notificationId = metaResult.success ? metaResult.data.notificationId : undefined
    if (notificationId) {
      readNotifications(queryClient, { kind: 'notification', id: notificationId })
        .catch(() => {
          // Best-effort: a stale notificationId is fine to silently ignore.
        })
    }

    // Platform notifications: clicking the OS notification opens the
    // markdown detail route and write-through-marks the platform row read
    // (it has no local DB record — the notificationId path above is a no-op).
    const platformCtx = NotificationActionContextSchema.safeParse(event.context)
    if (platformCtx.success && platformCtx.data.kind === 'platform_notification') {
      const platformNotificationId = platformCtx.data.platformNotificationId
      readPlatformNotifications(queryClient, [platformNotificationId])
        .catch(() => {
          // Best-effort: the detail view marks read on open anyway.
        })
      if (event.type === 'click') {
        void navigate({ to: '/notifications/$id', params: { id: platformNotificationId } })
      }
      return
    }

    // Action button interactions also dispatch a proxy-review decision.
    if (event.type !== 'action' || event.actionIndex === undefined) return

    const ctxResult = NotificationActionContextSchema.safeParse(event.context)
    if (!ctxResult.success) return
    const ctx = ctxResult.data
    if (ctx.kind !== 'proxy_review') return

    // Decision lookup is by index into ctx.decisions (set by the trigger),
    // not a hardcoded `index === 0 ? allow : deny`. Reordering the action
    // buttons no longer flips approve/deny silently. (Review S6.)
    const decision = ctx.decisions?.[event.actionIndex]
    if (decision !== 'allow' && decision !== 'deny') return

    apiFetch(`/api/agents/${ctx.agentSlug}/proxy-review/${ctx.reviewId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
      .then((res) => {
        if (!res.ok && res.status !== 404) {
          console.error('[notification-action] Failed to submit proxy review decision:', res.status)
        }
        queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
      })
      .catch((err) => {
        console.error('[notification-action] Error submitting proxy review decision:', err)
      })
  }, [queryClient, navigate])

  // Dispatch OS notification action button events (macOS only) back into the
  // app. For proxy reviews this means submitting Approve/Deny without the user
  // having to focus the window.
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.onNotificationEvent) return
    return window.electronAPI.onNotificationEvent(dispatchNotificationEvent)
  }, [dispatchNotificationEvent])

  // On mount, drain any notification interactions that fired while the
  // window was closed (the main-process SSE fallback queues them since the
  // renderer's IPC listeners don't yet exist at that point).
  const flushedRef = useRef(false)
  useEffect(() => {
    if (flushedRef.current) return
    flushedRef.current = true
    if (!isElectron() || !window.electronAPI?.flushPendingNotificationEvents) return
    window.electronAPI.flushPendingNotificationEvents().then(({ events, navigations }) => {
      for (const nav of navigations) {
        if (nav.sessionId) {
          void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: nav.agentSlug, sessionId: nav.sessionId } })
        } else {
          void navigate({ to: '/agents/$slug', params: { slug: nav.agentSlug } })
        }
      }
      for (const evt of events) {
        dispatchNotificationEvent(evt)
      }
    })
  }, [dispatchNotificationEvent, navigate])

  // Web Push keep-alive: with no service worker there is no
  // pushsubscriptionchange event, so re-upsert this device's subscription
  // once per app launch to repair endpoint rotation or a lost server row.
  useEffect(() => {
    if (supportsDeclarativeWebPush()) {
      void revalidatePushSubscription()
    }
  }, [])

  useEffect(() => {
    const baseUrl = getApiBaseUrl()
    const url = `${baseUrl}/api/notifications/stream`
    const es = new EventSource(url)
    streamRef.current = es
    const confirmations = createInvalidationCoalescer(queryClient, SESSION_CONFIRMATION_DELAY_MS)
    // One agent's session changed: its detail under every route key and the
    // list, once per burst. The list key is exact, since a prefix would also
    // refetch the detail of every agent a tab shows. Without an agent, any
    // agent may have changed.
    const confirmAgentSummaries = (agentSlug: string | undefined) => {
      if (!agentSlug) {
        confirmations.invalidate(['agents'])
        return
      }
      for (const key of agentDetailQueryKeys(queryClient, agentSlug)) confirmations.invalidate(key, { exact: true })
      confirmations.invalidate(['agents'], { exact: true })
    }
    // A patch does not stop a read already in flight, and that read would land
    // over it with the state from before the event. Refetching cancels it; a
    // query at rest is left alone.
    const refetchIfInFlight = (queryKey: QueryKey) => {
      if (queryClient.isFetching({ queryKey, exact: true }) > 0) void queryClient.invalidateQueries({ queryKey, exact: true })
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'connected':
            noteNotificationChange(queryClient)
            // The server sends this once the stream follows every channel it
            // carries, so what changes from here on arrives as an event. What
            // changed before it did not: the queries that loaded before the
            // first connect, a gap after a drop, a stream the server ended
            // because it fell behind. Read everything this feed keeps current
            // again. Every server version sends it as its first frame.
            queryClient.invalidateQueries({ predicate: isRefetchableAfterOutage })
            break

          case 'agent_members_changed':
          case 'agent_access_revoked': {
            const parsed = collaborationEventSchema.safeParse(data)
            if (!parsed.success) break
            const change = parsed.data
            if (change.type === 'agent_access_revoked') {
              const activeSlug = selectedAgentRef.current
              const activeId = resolveRouteAgentId(activeSlug ?? undefined, queryClient.getQueryData<ApiAgent[]>(['agents']))
              if (activeId === change.agentSlug) void navigate({ to: '/' })
              // Don't retain a revoked roster while refetches are in flight.
              queryClient.setQueryData(['agent-members', change.agentSlug], [])
              queryClient.setQueryData<Record<string, unknown>>(['my-agent-roles'], (roles) => {
                if (!roles) return roles
                const remaining = { ...roles }
                delete remaining[change.agentSlug]
                return remaining
              })
              const revokedQueries = { predicate: (query: { queryKey: readonly unknown[] }) =>
                query.queryKey.includes(change.agentSlug) || (!!activeSlug && activeId === change.agentSlug && query.queryKey.includes(activeSlug)) }
              void queryClient.cancelQueries(revokedQueries).then(() => queryClient.removeQueries(revokedQueries))
            } else {
              queryClient.invalidateQueries({ queryKey: ['agent-members', change.agentSlug] })
              queryClient.invalidateQueries({ queryKey: ['agent-invite-candidates', change.agentSlug] })
            }
            queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
            invalidateNotificationCaches(queryClient)
            break
          }

          case 'notifications_changed': {
            const parsed = notificationChangeSchema.safeParse(data)
            if (!parsed.success || parsed.data.sourceClientId === notificationClientId(queryClient)) break
            invalidateNotificationCaches(queryClient, parsed.data.agentSlug)
            break
          }

          case 'session_mention_withdrawn': {
            invalidateNotificationCaches(queryClient, typeof data.agentSlug === 'string' ? data.agentSlug : undefined)
            break
          }

          case 'platform_notifications_changed': {
            // A platform notification INSERT arrived over Realtime — refresh
            // the proxy-live inbox + badge (there is no local copy to update).
            queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
            break
          }

          case 'os_notification': {
            if (data.notificationType === 'platform_notification') {
              queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
            } else {
              noteNotificationChange(queryClient, typeof data.agentSlug === 'string' ? data.agentSlug : undefined)
              queryClient.invalidateQueries({ queryKey: ['notifications'] })
            }
            // Refresh sessions so unread indicators update in sidebar. In the
            // batch: a completion lands just after its session_idle, which
            // refreshes the same list.
            const notifAgentSlug = data.agentSlug as string | undefined
            if (notifAgentSlug) {
              confirmations.invalidate(['sessions', notifAgentSlug])
            }

            // Automation-triggered sessions: refresh the trigger/task session lists
            // and the trigger/task detail so the UI updates in real time.
            const notifType = data.notificationType as string | undefined
            if (notifType === 'session_webhook' && data.triggerId) {
              queryClient.invalidateQueries({ queryKey: ['webhook-trigger-sessions', data.triggerId] })
              queryClient.invalidateQueries({ queryKey: ['webhook-trigger', data.triggerId] })
            } else if (notifType === 'session_scheduled' && data.taskId) {
              queryClient.invalidateQueries({ queryKey: ['scheduled-task-sessions', data.taskId] })
              queryClient.invalidateQueries({ queryKey: ['scheduled-task', data.taskId] })
            }
            if (notifType && (USER_ACTIONABLE_NOTIFICATION_TYPES as readonly string[]).includes(notifType)) {
              // Completion enrichment may finish after the lifecycle refetch.
              confirmAgentSummaries(notifAgentSlug)
              const notifSessionId = data.sessionId as string | undefined
              queryClient.invalidateQueries({ queryKey: notifSessionId ? ['session', notifSessionId] : ['session'] })
            }

            // Skip if user doesn't have access to the notification's agent
            const agentSlug = data.agentSlug as string | undefined
            if (agentSlug && !canAccessAgentRef.current(agentSlug)) break

            const notificationSessionId = data.sessionId as string | undefined
            const isViewingNotificationSession = notificationSessionId === selectedSessionIdRef.current
            const isTabVisible = document.visibilityState === 'visible'

            const notificationType = data.notificationType as string | undefined

            // For actionable types (`session_waiting`) we also surface the
            // notification when the window is on screen but unfocused —
            // `document.visibilityState` stays 'visible' on alt-tab, so
            // without `hasFocus()` the user can be "looking at" a session
            // they're actually ignoring while in another app, and miss
            // the prompt. For chattier types (chat-integration, etc.) we
            // keep the visibility-only gate to avoid notification spam
            // for users who keep the window in a side panel. (Review S4.)
            // `notifyWhenUnfocused` opts the chattier types into the same
            // focus-aware gate.
            const notifyWhenUnfocused =
              userSettingsRef.current?.notifications?.notifyWhenUnfocused === true
            const isAppActive =
              notificationType === 'session_waiting' || notificationType === 'session_mention' || notifyWhenUnfocused
                ? isTabVisible && document.hasFocus()
                : isTabVisible

            // The user is actively watching this session right now when the app
            // is active (focus-aware for actionable / opted-in types) AND this
            // is the session on screen. The backend always creates the DB
            // notification record; here we only decide whether to pop an OS
            // notification on top of it.
            const typeEnabled = isNotificationTypeEnabled(userSettingsRef.current, notificationType ?? '')
            const suppressedByActiveView = isAppActive && isViewingNotificationSession

            // Show OS notification if:
            // 1. User has access to the notification's agent
            // 2. User's notification settings allow this type
            // 3. App not active OR not viewing the notification's session
            if (typeEnabled && !suppressedByActiveView) {
              // Optimistic raise of the unread dot for the user-actionable
              // types that set it server-side — the mirror of the already-
              // optimistic clear (clearSessionUnreadInCache). Only here: the
              // suppressed branch below marks the record read instead, and
              // for disabled types the server-side gate creates no record.
              // The sessions refetch invalidated above confirms; the agent
              // rollup and preview are confirmed by this event's agents refetch.
              if (
                notificationType
                && (USER_ACTIONABLE_NOTIFICATION_TYPES as readonly string[]).includes(notificationType)
                && agentSlug && notificationSessionId
              ) {
                applySessionActivityStatus(queryClient, agentSlug, notificationSessionId, {
                  hasUnreadNotifications: true,
                  ...(notificationType === 'session_mention' ? { hasUnreadMention: true } : {}),
                })
              }
              const { title, body } = data as { title: string; body: string }
              // Validate actions at the SSE boundary. A malicious / buggy
              // broadcaster can't inject a 1000-button notification with
              // multi-KB labels — schema caps to MAX_NOTIFICATION_ACTIONS
              // and MAX_NOTIFICATION_ACTION_TEXT_LENGTH (review N2).
              const actionsResult = NotificationActionsArraySchema.safeParse(data.actions)
              const actions = actionsResult.success && actionsResult.data.length > 0
                ? actionsResult.data
                : undefined
              const baseContext = (data.actionContext as Record<string, unknown> | undefined) ?? {}
              // Always carry agentSlug/sessionId in context so clicking the
              // notification navigates to the right place (otherwise main just
              // focuses the window and drops the user on the homepage). Also
              // carry notificationId so the dispatcher can mark the DB record
              // as read when the user interacts with the OS notification.
              const context = {
                ...baseContext,
                agentSlug: agentSlug ?? baseContext.agentSlug,
                sessionId: notificationSessionId ?? baseContext.sessionId,
                notificationId: data.notificationId ?? baseContext.notificationId,
              }
              // Web Notifications have no context round-trip — wire the click
              // straight to the platform detail route (Electron routes the
              // click through dispatchNotificationEvent instead).
              const platformNotificationId =
                notificationType === 'platform_notification' &&
                typeof data.platformNotificationId === 'string'
                  ? data.platformNotificationId
                  : null
              const onClick = platformNotificationId
                ? () =>
                    void navigate({
                      to: '/notifications/$id',
                      params: { id: platformNotificationId },
                    })
                : undefined
              showOSNotification(title, body, onClick, { actions, context })
            } else if (suppressedByActiveView && typeof data.notificationId === 'string') {
              // Popup suppressed because the user is actively viewing this
              // focused session — but the backend still created the DB record.
              // Mark it read here, otherwise the unread badge inflates for a
              // session the user is watching live. main-content's auto-mark-read
              // only fires on session open / tab refocus, not for notifications
              // that arrive mid-view. (PR #175 follow-up.)
              readNotifications(queryClient, { kind: 'notification', id: data.notificationId })
                .catch(() => {
                  // Best-effort: a stale notificationId is fine to silently ignore.
                })
            }
            break
          }

          case 'session_active':
          case 'session_idle':
          case 'session_error':
          case 'session_awaiting_input':
          case 'session_input_provided': {
            // Session state changed - update sessions list in sidebar
            // Scope invalidation to the specific agent to avoid flashing "working" on other agents
            const eventAgentSlug = data.agentSlug as string | undefined
            const eventSessionId = data.sessionId as string | undefined
            // Optimistic echo for the status flip: the invalidations below
            // trigger refetches of very different cost (session list, agent
            // detail, full agents list), so without this the session row, the
            // header pill, and the agent row flip seconds apart as each
            // refetch lands. Patch every cached projection first; the
            // refetches stay authoritative.
            const statusPatch =
              SESSION_LIFECYCLE_ECHO[data.type as keyof typeof SESSION_LIFECYCLE_ECHO]
            if (statusPatch && eventAgentSlug && eventSessionId) {
              applySessionActivityStatus(queryClient, eventAgentSlug, eventSessionId, statusPatch)
            }
            // A status flip of a session this tab already lists: the echo above
            // is the whole update for its rows. A raise also proves the agent's
            // rollup; a clear does not, since hidden automated sessions and
            // agent-level reviews count toward it unseen.
            const raise = data.type === 'session_active' || data.type === 'session_awaiting_input'
            const lists = (raise || data.type === 'session_input_provided') && eventAgentSlug && eventSessionId
              ? sessionListMembership(queryClient, eventAgentSlug, eventSessionId)
              : []
            const listed = lists.some((list) => list.full && list.holds)
            const sessionsKey = eventAgentSlug ? ['sessions', eventAgentSlug] : ['sessions']
            if (listed) {
              // Only the server can add the session to a list that lacks it,
              // or take it out of a slice of live sessions after a clear.
              for (const list of lists) {
                if (!list.holds || (!raise && !list.full)) queryClient.invalidateQueries({ queryKey: list.queryKey, exact: true })
                else refetchIfInFlight(list.queryKey)
              }
            } else if (data.hidden === true && eventAgentSlug) {
              // A hidden automated session (cron, webhook, chat): only the
              // slices that hold automations can change.
              invalidateAutomationSessionLists(queryClient, eventAgentSlug)
            } else if (data.type === 'session_idle') {
              // A finished turn's completion notification follows and refreshes
              // the same list; in one batch the two fetch it once.
              confirmations.invalidate(sessionsKey)
            } else {
              queryClient.invalidateQueries({ queryKey: sessionsKey })
            }
            // Agent list + detail includes pre-aggregated session status (hasActiveSessions, etc.).
            if (listed && raise && eventAgentSlug) {
              for (const key of [['agents'], ...agentDetailQueryKeys(queryClient, eventAgentSlug)]) refetchIfInFlight(key)
            } else {
              confirmAgentSummaries(eventAgentSlug)
            }
            // Todo board columns are live session state.
            confirmations.invalidate(TODOS_QUERY_KEY)
            // Artifacts can only change while the agent works: read that
            // agent's when it stops, not when it starts.
            if (data.type === 'session_idle' || data.type === 'session_error' || data.type === 'session_awaiting_input') {
              if (eventAgentSlug) {
                invalidateAgentArtifacts(queryClient, eventAgentSlug)
              } else {
                queryClient.invalidateQueries({ queryKey: ['artifacts'] })
              }
            }

            // A finished run may have changed Team Brain's drive: its tree and sync summaries read again (none for other agents).
            if ((data.type === 'session_idle' || data.type === 'session_error') && eventAgentSlug) confirmations.invalidate(['team-brain', eventAgentSlug])

            // Automation session lists show isActive status — refresh them
            confirmations.invalidate(['webhook-trigger-sessions'])
            confirmations.invalidate(['scheduled-task-sessions'])

            break
          }

          case 'user_request_created':
          case 'user_request_resolved':
            // Unified pending-request wire. Invalidation, not data: the
            // refetch reads the server registry snapshot. This is the live
            // path for agent-scoped reviews (they have no session stream) and
            // the cross-tab/cross-session sync for everything else; the
            // store's interval refetch is the safety net for a missed event.
            queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
            break

          case 'agent_status_changed': {
            // Status is already in the event; preserve cached summaries instead
            // of refetching every agent. Artifact runtime state is agent-scoped.
            const agentSlug = data.agentSlug as string | undefined
            const status = data.status === 'running' || data.status === 'stopped'
              ? data.status
              : undefined
            if (agentSlug && status) {
              updateAgentRuntimeCache(queryClient, agentSlug, status)
              invalidateAgentArtifacts(queryClient, agentSlug)
            }
            break
          }

          case 'dashboard_screenshot_ready': {
            const agentSlug = data.agentSlug as string | undefined
            const dashboardSlug = data.dashboardSlug as string | undefined
            if (agentSlug && dashboardSlug) {
              markDashboardScreenshotReady(queryClient, agentSlug, dashboardSlug)
            }
            break
          }

          case 'widget_refresh_started': {
            const agentSlug = data.agentSlug as string | undefined
            const widgetSlug = data.widgetSlug as string | undefined
            if (agentSlug && widgetSlug) {
              patchAgentWidget(queryClient, agentSlug, widgetSlug, { refreshing: true })
            }
            break
          }

          case 'widget_snapshot_ready': {
            // The event carries the new snapshot identity, so patch the cards
            // in place (the iframe URL keys on htmlHash) and refetch the
            // listing quietly for anything else that changed.
            const agentSlug = data.agentSlug as string | undefined
            const widgetSlug = data.widgetSlug as string | undefined
            if (agentSlug && widgetSlug) {
              const error = typeof data.error === 'string' ? data.error : null
              patchAgentWidget(queryClient, agentSlug, widgetSlug, {
                refreshing: false,
                isStale: false,
                lastError: error,
                ...(typeof data.htmlHash === 'string' ? { htmlHash: data.htmlHash, hasHtml: true } : {}),
                ...(typeof data.generatedAt === 'string' ? { generatedAt: data.generatedAt } : {}),
                validUntil: typeof data.validUntil === 'string' ? data.validUntil : null,
              })
              invalidateAgentWidgets(queryClient, agentSlug)
            }
            break
          }

          case 'widget_refresh_failed': {
            const agentSlug = data.agentSlug as string | undefined
            const widgetSlug = data.widgetSlug as string | undefined
            if (agentSlug && widgetSlug) {
              patchAgentWidget(queryClient, agentSlug, widgetSlug, {
                refreshing: false,
                lastError: typeof data.error === 'string' ? data.error : 'Refresh failed',
              })
            }
            break
          }

          case 'dashboard_status_changed': {
            // Patch the cached artifact status so a waiting DashboardView flips
            // immediately, then refetch for the authoritative list (port,
            // startup phase, entries the cache has not seen yet).
            const agentSlug = data.agentSlug as string | undefined
            const dashboardSlug = data.dashboardSlug as string | undefined
            const status = data.status === 'running' || data.status === 'crashed'
              ? data.status
              : undefined
            if (agentSlug && dashboardSlug && status) {
              applyDashboardRuntimeStatus(queryClient, agentSlug, dashboardSlug, status)
              invalidateAgentArtifacts(queryClient, agentSlug)
            }
            break
          }

          case 'container_health_changed':
            // Container health warnings changed - update agent list
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            break

          case 'agent_updated':
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            break

          case 'volume_attention_changed':
            // A drive changed: its settings, its folder, or its sync state. Its rows and status pills follow.
            queryClient.invalidateQueries({ queryKey: ['mounts'] })
            queryClient.invalidateQueries({ queryKey: ['volume-definitions'] })
            queryClient.invalidateQueries({ queryKey: ['volume-agents'] })
            break

          case 'agent_created':
            // Agent-created child creation lands outside the human create mutation,
            // so refresh both caches the direct-create path invalidates together.
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
            break

          case 'scheduled_task_created':
          case 'scheduled_task_cancelled':
          case 'scheduled_task_updated': {
            // Scheduled task created, cancelled, or updated - update task list and agent card summary
            const agentSlug = data.agentSlug as string | undefined
            if (agentSlug) {
              queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', agentSlug] })
            }
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            break
          }

          case 'session_updated': {
            // Session-level state changed outside a session stream (e.g. a
            // pending wake was created/cancelled/fired) — refresh session
            // lists so sidebar badges and the resume banner stay current.
            const agentSlug = data.agentSlug as string | undefined
            const sessionId = data.sessionId as string | undefined
            if (agentSlug) {
              queryClient.invalidateQueries({ queryKey: ['sessions', agentSlug] })
            } else {
              queryClient.invalidateQueries({ queryKey: ['sessions'] })
            }
            if (sessionId) {
              queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
            }
            // Todo cards show a pending wake as waiting.
            confirmations.invalidate(TODOS_QUERY_KEY)
            if (agentSlug) {
              queryClient.invalidateQueries({ queryKey: ['activity-stats', 'agent', agentSlug] })
              queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', agentSlug] })
            }
            break
          }

          case 'webhook_trigger_created':
          case 'webhook_trigger_updated':
          case 'webhook_trigger_cancelled': {
            const agentSlug = data.agentSlug as string | undefined
            if (agentSlug) {
              queryClient.invalidateQueries({ queryKey: ['webhook-triggers', agentSlug] })
            }
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            break
          }

          case 'mount_health_warning': {
            // An empty list clears the banner.
            setMountWarning(queryClient, {
              agentSlug: data.agentSlug,
              notMounted: data.notMounted,
            })
            break
          }

          case 'runtime_readiness_changed': {
            const readiness = data.readiness as RuntimeReadiness | undefined
            const previous =
              queryClient.getQueryData<RuntimeStatusResponse>(['runtime-status'])?.runtimeReadiness ??
              queryClient.getQueryData<GlobalSettingsResponse>(['settings'])?.runtimeReadiness
            // An image pull sends a progress event about every second with the same
            // status. Patch the new readiness in instead of refetching every
            // settings query per tick; a status change (e.g. to READY) still refetches.
            if (readiness && previous?.status === readiness.status) {
              queryClient.setQueryData<RuntimeStatusResponse>(['runtime-status'], (old) => old && { ...old, runtimeReadiness: readiness })
              queryClient.setQueryData<GlobalSettingsResponse>(['settings'], (old) => old && { ...old, runtimeReadiness: readiness })
              break
            }
            queryClient.invalidateQueries({ queryKey: ['settings'] })
            queryClient.invalidateQueries({ queryKey: ['runtime-status'] })
            break
          }

          case 'webhook_relay_changed':
            queryClient.setQueryData(WEBHOOK_RELAY_QUERY_KEY, data.status)
            break
        }
      } catch {
        // Ignore parse errors for ping/connected messages
      }
    }

    // Opening is not the time to refetch: the server may still be setting up
    // what the stream follows. `connected` is (see above).
    es.onopen = () => {
      reconnectAttemptRef.current = 0
    }

    es.onerror = () => {
      // Network errors reconnect in the browser. Fatal close is the watcher.
    }

    const disposeLiveness = watchStreamLiveness(es, () => {
      if (streamRef.current !== es) return
      es.close()
      const delay = reconnectDelayMs(reconnectAttemptRef.current)
      reconnectAttemptRef.current += 1
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        if (streamRef.current !== es) return
        setReconnectKey((k) => k + 1)
      }, delay)
    })

    return () => {
      disposeLiveness()
      confirmations.flush()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
      if (streamRef.current === es) streamRef.current = null
      es.close()
    }
  }, [queryClient, navigate, reconnectKey])

  return null
}
