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

export function GlobalNotificationHandler() {
  const queryClient = useQueryClient()
  const { selectedSessionId } = useSelection()
  const { data: unreadData } = useUnreadNotificationCount()
  // Use ref to avoid recreating EventSource when selectedSessionId changes
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId

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

            // Show notification if tab is hidden OR not viewing the notification's session
            if (!isTabVisible || !isViewingNotificationSession) {
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
            break

          case 'agent_status_changed':
            // Agent started/stopped - update agent list
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
