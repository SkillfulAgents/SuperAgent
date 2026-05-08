/**
 * OS Notification utilities
 *
 * Handles showing system notifications in both web and Electron contexts.
 */

import { isElectron } from './env'

/**
 * Request permission to show web notifications.
 * Returns true if permission is granted.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  // In Electron, we don't need permission
  if (isElectron()) {
    return true
  }

  // Check if Notifications API is available
  if (!('Notification' in window)) {
    console.warn('Notifications API not supported')
    return false
  }

  // Already granted
  if (Notification.permission === 'granted') {
    return true
  }

  // Already denied
  if (Notification.permission === 'denied') {
    return false
  }

  // Request permission
  const permission = await Notification.requestPermission()
  return permission === 'granted'
}

/**
 * Check if notification permission is granted.
 */
export function hasNotificationPermission(): boolean {
  if (isElectron()) {
    return true
  }

  if (!('Notification' in window)) {
    return false
  }

  return Notification.permission === 'granted'
}

/**
 * Show an OS notification.
 *
 * `actions` + `context` enable action buttons. macOS-only: the Web
 * Notification API and Windows/Linux Electron notifications ignore the
 * actions array. The `context` is opaque metadata that flows back to
 * onNotificationEvent listeners on click/action.
 */
export async function showOSNotification(
  title: string,
  body: string,
  onClick?: () => void,
  options?: {
    actions?: Array<{ text: string }>
    context?: unknown
  },
): Promise<void> {
  if (isElectron() && window.electronAPI?.showNotification) {
    // Use Electron's native notification
    try {
      await window.electronAPI.showNotification(title, body, options?.actions, options?.context)
    } catch (err) {
      console.error('[showOSNotification] electron IPC rejected:', err)
    }
  } else if ('Notification' in window && Notification.permission === 'granted') {
    // Use Web Notifications API (no action support)
    const notification = new Notification(title, {
      body,
      icon: '/icon.png',
    })

    if (onClick) {
      notification.onclick = () => {
        window.focus()
        onClick()
      }
    }
  }
}
