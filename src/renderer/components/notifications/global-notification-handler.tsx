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

import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import type { UserSettingsData } from '@shared/lib/services/user-settings-service'
import {
  NotificationActionContextSchema,
  NotificationEventSchema,
  NotificationActionsArraySchema,
  NotificationMetadataSchema,
} from '@shared/lib/notifications/notification-action-schema'
import { useRenderTracker } from '@renderer/lib/perf'

function isNotificationTypeEnabled(
  settings: UserSettingsData | undefined,
  notificationType: string
): boolean {
  const n = settings?.notifications
  if (!n?.enabled) return n === undefined // no settings loaded yet → allow; explicitly disabled → block
  switch (notificationType) {
    case 'session_complete': return n.sessionComplete !== false
    case 'session_waiting': return n.sessionWaiting !== false
    case 'session_scheduled': return n.sessionScheduled !== false
    case 'platform_notification': return n.platformNotification !== false
    default: return true
  }
}

export function GlobalNotificationHandler() {
  useRenderTracker('GlobalNotificationHandler')
  const queryClient = useQueryClient()
  const { view } = useRouteLocation()
  const navigate = useNavigate()
  const selectedSessionId = view.kind === 'session' ? view.id : null
  const { data: unreadData } = useUnreadNotificationCount()
  const { data: platformUnreadData } = usePlatformUnreadCount()
  const { data: userSettings } = useUserSettings()
  const { canAccessAgent } = useUser()
  // Use refs to avoid recreating EventSource when reactive values change
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId
  const userSettingsRef = useRef(userSettings)
  userSettingsRef.current = userSettings
  const canAccessAgentRef = useRef(canAccessAgent)
  canAccessAgentRef.current = canAccessAgent

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
      apiFetch(`/api/notifications/${notificationId}/read`, { method: 'POST' })
        .then((res) => {
          if (res.ok) {
            queryClient.invalidateQueries({ queryKey: ['notifications'] })
          }
        })
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
      apiFetch('/api/platform-notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [platformNotificationId] }),
      })
        .then((res) => {
          if (res.ok) {
            queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
          }
        })
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
        queryClient.invalidateQueries({ queryKey: ['proxy-reviews', ctx.agentSlug] })
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

  useEffect(() => {
    const baseUrl = getApiBaseUrl()
    const url = `${baseUrl}/api/notifications/stream`
    const es = new EventSource(url)

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'platform_notifications_changed': {
            // A platform notification INSERT arrived over Realtime — refresh
            // the proxy-live inbox + badge (there is no local copy to update).
            queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
            break
          }

          case 'os_notification': {
            // Refresh notification list (for badge/dropdown)
            queryClient.invalidateQueries({ queryKey: ['notifications'] })
            if (data.notificationType === 'platform_notification') {
              queryClient.invalidateQueries({ queryKey: ['platform-notifications'] })
            }
            // Refresh sessions so unread indicators update in sidebar
            const notifAgentSlug = data.agentSlug as string | undefined
            if (notifAgentSlug) {
              queryClient.invalidateQueries({ queryKey: ['sessions', notifAgentSlug] })
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
              notificationType === 'session_waiting' || notifyWhenUnfocused
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
              apiFetch(`/api/notifications/${data.notificationId}/read`, { method: 'POST' })
                .then((res) => {
                  if (res.ok) {
                    queryClient.invalidateQueries({ queryKey: ['notifications'] })
                  }
                })
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
            if (eventAgentSlug) {
              queryClient.invalidateQueries({ queryKey: ['sessions', eventAgentSlug] })
            } else {
              queryClient.invalidateQueries({ queryKey: ['sessions'] })
            }
            // Agent list + detail includes pre-aggregated session status (hasActiveSessions, etc.)
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            if (eventAgentSlug) {
              queryClient.invalidateQueries({ queryKey: ['agents', eventAgentSlug] })
            }
            // Artifacts may have been created/modified during the session
            queryClient.invalidateQueries({ queryKey: ['artifacts'] })

            // Automation session lists show isActive status — refresh them
            queryClient.invalidateQueries({ queryKey: ['webhook-trigger-sessions'] })
            queryClient.invalidateQueries({ queryKey: ['scheduled-task-sessions'] })

            // Proxy review created or resolved — refetch review list
            if (eventAgentSlug && data.review) {
              queryClient.invalidateQueries({ queryKey: ['proxy-reviews', eventAgentSlug] })
            }
            break
          }

          case 'agent_status_changed':
            // Agent started/stopped - update agent list and artifacts
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            queryClient.invalidateQueries({ queryKey: ['artifacts'] })
            break

          case 'container_health_changed':
            // Container health warnings changed - update agent list
            queryClient.invalidateQueries({ queryKey: ['agents'] })
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
            break
          }

          case 'webhook_trigger_created':
          case 'webhook_trigger_cancelled': {
            const agentSlug = data.agentSlug as string | undefined
            if (agentSlug) {
              queryClient.invalidateQueries({ queryKey: ['webhook-triggers', agentSlug] })
            }
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            break
          }

          case 'mount_health_warning': {
            // Some mounted folders are missing or inaccessible — show banner in agent view
            setMountWarning(queryClient, {
              agentSlug: data.agentSlug,
              missingMounts: data.missingMounts,
              hint: data.hint,
            })
            break
          }

          case 'runtime_readiness_changed':
            // Runtime readiness changed (e.g., image pull started/completed)
            queryClient.invalidateQueries({ queryKey: ['settings'] })
            queryClient.invalidateQueries({ queryKey: ['runtime-status'] })
            break
        }
      } catch {
        // Ignore parse errors for ping/connected messages
      }
    }

    es.onerror = () => {
      // EventSource will auto-reconnect
    }

    return () => {
      es.close()
    }
  }, [queryClient, navigate])

  return null
}
