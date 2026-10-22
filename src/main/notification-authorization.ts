import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { KoffiFunc } from 'koffi'

/** Built by scripts/build-macos-bridges.sh from native/macos/NotificationBridge.swift. */
const NOTIFICATION_BRIDGE_FILE = 'libNotificationBridge.dylib'

function notificationBridgePath(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'notification-bridge')
    : path.join(app.getAppPath(), 'build', 'notification-bridge')
  return path.join(dir, NOTIFICATION_BRIDGE_FILE)
}

let statusNative: Promise<KoffiFunc<() => string> | null> | null = null

function loadStatusNative(): Promise<KoffiFunc<() => string> | null> {
  statusNative ??= (async () => {
    const file = notificationBridgePath()
    if (!fs.existsSync(file)) return null
    try {
      // Imported here: koffi throws on import where it has no native addon.
      const { load } = await import('koffi')
      // `str!` frees the returned string after converting it.
      return load(file).func('str! notification_authorization_status()') as KoffiFunc<() => string>
    } catch (error) {
      console.error('[Notifications] Failed to load the notification bridge:', error)
      return null
    }
  })()
  return statusNative
}

/**
 * True when the user turned off notifications for this app in macOS System
 * Settings. False on other platforms and when the bridge is not built.
 */
export async function areOsNotificationsBlocked(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const status = await loadStatusNative()
  if (!status) return false
  return new Promise((resolve) => {
    status.async((err: unknown, value: string) => {
      if (err) console.error('[Notifications] Failed to read the notification permission:', err)
      resolve(!err && value === 'denied')
    })
  })
}
