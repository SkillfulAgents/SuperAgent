// The app's macOS notification permission, for the Electron main process.
// Built into libNotificationBridge.dylib by scripts/build-spotlight-bridge.sh and
// called through koffi (src/main/notification-authorization.ts).
//
// It has to run inside the app's own process: UNUserNotificationCenter answers
// for the bundle of the calling process. Electron has no API for this, and when
// the user turns notifications off, macOS still accepts every request and
// hides it, so Electron's `failed` event never fires.
//
// koffi runs it on a worker thread, so blocking on the completion handler here
// never blocks the main process.

import Foundation
import UserNotifications

@_cdecl("notification_authorization_status")
public func notificationAuthorizationStatus() -> UnsafeMutablePointer<CChar>? {
  let done = DispatchSemaphore(value: 0)
  var status = "unknown"
  UNUserNotificationCenter.current().getNotificationSettings { settings in
    switch settings.authorizationStatus {
    case .notDetermined: status = "notDetermined"
    case .denied: status = "denied"
    case .authorized: status = "authorized"
    case .provisional: status = "provisional"
    case .ephemeral: status = "ephemeral"
    @unknown default: status = "unknown"
    }
    done.signal()
  }
  done.wait()
  return strdup(status)
}
