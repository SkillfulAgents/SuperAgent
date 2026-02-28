/**
 * Global Notification Handler
 *
 * Connects to the global SSE stream and handles:
 * - OS notifications (when tab not visible OR not viewing the notification's session)
 * - Session state changes (active/idle) - updates sidebar
 * - Agent status changes (running/stopped) - updates agent list
 * - Scheduled task updates - updates task list
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getApiBaseUrl, isElectron } from '@renderer/lib/env'
import { showOSNotification } from '@renderer/lib/os-notifications'
import { useSelection } from '@renderer/context/selection-context'
import { useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import type { UserSettingsData } from '@shared/lib/services/user-settings-service'

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
    default: return true
  }
}

export function GlobalNotificationHandler() {
  const queryClient = useQueryClient()
  const { selectedSessionId } = useSelection()
  const { data: unreadData } = useUnreadNotificationCount()
  const { data: userSettings } = useUserSettings()
  // Use refs to avoid recreating EventSource when reactive values change
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId
  const userSettingsRef = useRef(userSettings)
  userSettingsRef.current = userSettings

  // Sync dock badge count with unread notifications (macOS Electron only)
  useEffect(() => {
    if (isElectron() && window.electronAPI?.setBadgeCount) {
      const count = unreadData?.count ?? 0
      window.electronAPI.setBadgeCount(count)
    }
  }, [unreadData?.count])

  useEffect(() => {
    const baseUrl = getApiBaseUrl()
    const url = `${baseUrl}/api/notifications/stream`
    const es = new EventSource(url)

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'os_notification': {
            // Refresh notification list (for badge/dropdown)
            queryClient.invalidateQueries({ queryKey: ['notifications'] })

            const notificationSessionId = data.sessionId as string | undefined
            const isViewingNotificationSession = notificationSessionId === selectedSessionIdRef.current
            const isTabVisible = document.visibilityState === 'visible'

            // Show OS notification if:
            // 1. User's notification settings allow this type
            // 2. Tab is hidden OR not viewing the notification's session
            const notificationType = data.notificationType as string | undefined
            if (
              isNotificationTypeEnabled(userSettingsRef.current, notificationType ?? '') &&
              (!isTabVisible || !isViewingNotificationSession)
            ) {
              const { title, body } = data as { title: string; body: string }
              showOSNotification(title, body)
            }
            break
          }

          case 'session_active':
          case 'session_idle':
          case 'session_error':
            // Session state changed - update sessions list in sidebar
            queryClient.invalidateQueries({ queryKey: ['sessions'] })
            // Artifacts may have been created/modified during the session
            queryClient.invalidateQueries({ queryKey: ['artifacts'] })
            break

          case 'agent_status_changed':
            // Agent started/stopped - update agent list and artifacts
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            queryClient.invalidateQueries({ queryKey: ['artifacts'] })
            break

          case 'container_health_changed':
            // Container health warnings changed - update agent list
            queryClient.invalidateQueries({ queryKey: ['agents'] })
            break

          case 'scheduled_task_created': {
            // Scheduled task created - update task list for that agent
            const agentSlug = data.agentSlug as string | undefined
            if (agentSlug) {
              queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', agentSlug] })
            }
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
  }, [queryClient])

  return null
}
