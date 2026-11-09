// Sign-in through ASWebAuthenticationSession, for the Electron main process.
// Built into libWebAuthBridge.dylib by scripts/build-spotlight-bridge.sh and
// called through koffi (src/main/web-auth-session.ts).
//
// The Mac App Store build signs in to the Gamut account this way: App Review
// (guideline 4) rejects an app that sends the person to their default browser
// to sign in, unless it does so through this session. Electron has no API for
// it, and it has to run inside the app's own process: the session's sheet is
// anchored to one of the app's windows.
//
// koffi runs `web_auth_start` on a worker thread, so blocking on the session
// here never blocks the main process. The session itself is started on the
// main queue, which Electron's main thread drains.

import AppKit
import AuthenticationServices
import Foundation

private final class WindowAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? ASPresentationAnchor()
  }
}

// Read and written on the main queue only. The session and its anchor are kept
// here because nothing else retains them while the sheet is up.
private var activeSession: ASWebAuthenticationSession?
private var activeAnchor: WindowAnchor?

private func result(_ fields: [String: Any]) -> UnsafeMutablePointer<CChar>? {
  let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{\"error\":\"unencodable result\"}".utf8)
  return strdup(String(decoding: data, as: UTF8.self))
}

/// Runs one sign-in and returns when it ends, as JSON: `{"url": "<callback>"}`
/// when the page reached the callback scheme, `{"cancelled": true}` when the
/// person closed the sheet (or `web_auth_cancel` did), `{"error": "…"}`
/// otherwise. A session still up when this is called is cancelled first.
@_cdecl("web_auth_start")
public func webAuthStart(_ urlText: UnsafePointer<CChar>, _ schemeText: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  let scheme = String(cString: schemeText)
  guard let url = URL(string: String(cString: urlText)), !scheme.isEmpty else {
    return result(["error": "invalid sign-in URL"])
  }

  let done = DispatchSemaphore(value: 0)
  var outcome: [String: Any] = ["error": "the sign-in session did not start"]

  DispatchQueue.main.async {
    activeSession?.cancel()

    // The completion handler names the session it belongs to, which exists
    // only once the initializer it is passed to returns.
    var started: ASWebAuthenticationSession?
    let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callbackURL, error in
      if let callbackURL {
        outcome = ["url": callbackURL.absoluteString]
      } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
        outcome = ["cancelled": true]
      } else {
        outcome = ["error": error?.localizedDescription ?? "the sign-in session ended without a result"]
      }
      DispatchQueue.main.async {
        // A newer session may already have replaced this one.
        if activeSession === started {
          activeSession = nil
          activeAnchor = nil
        }
        done.signal()
      }
    }
    started = session

    let anchor = WindowAnchor()
    session.presentationContextProvider = anchor
    // The person's browser session carries over, so someone already signed in
    // on the web is not asked for their password again.
    session.prefersEphemeralWebBrowserSession = false
    activeSession = session
    activeAnchor = anchor
    if !session.start() {
      activeSession = nil
      activeAnchor = nil
      outcome = ["error": "the sign-in session could not be started"]
      done.signal()
    }
  }

  done.wait()
  return result(outcome)
}

/// Ends the session that is up, if any. Its `web_auth_start` returns cancelled.
@_cdecl("web_auth_cancel")
public func webAuthCancel() {
  DispatchQueue.main.async {
    activeSession?.cancel()
  }
}
