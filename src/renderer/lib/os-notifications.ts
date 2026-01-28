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
 */
export async function showOSNotification(
  title: string,
  body: string,
  onClick?: () => void
): Promise<void> {
  if (isElectron() && window.electronAPI?.showNotification) {
    // Use Electron's native notification
    await window.electronAPI.showNotification(title, body)
  } else if ('Notification' in window && Notification.permission === 'granted') {
    // Use Web Notifications API
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
