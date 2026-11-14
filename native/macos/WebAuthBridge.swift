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
import CryptoKit
import Foundation
import Security

/// The app window a sheet attaches to.
private func appWindow() -> ASPresentationAnchor {
  NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? ASPresentationAnchor()
}

private final class WindowAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    appWindow()
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

// MARK: - Sign in with Apple

// The native Apple prompt for the Mac App Store build's "Sign in with Apple".
// The raw nonce is made here and returned with the token; Apple receives only
// its SHA-256, and the platform hands the raw value to Supabase to check it.

private final class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private let rawNonce: String
  private let finish: ([String: Any]) -> Void
  // Main queue only. Apple and a replacing start can both end the same request.
  private var finished = false

  init(rawNonce: String, finish: @escaping ([String: Any]) -> Void) {
    self.rawNonce = rawNonce
    self.finish = finish
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    appWindow()
  }

  func end(_ fields: [String: Any]) {
    guard !finished else { return }
    finished = true
    finish(fields)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    guard
      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
      let tokenData = credential.identityToken,
      let idToken = String(data: tokenData, encoding: .utf8)
    else {
      end(["error": "Apple returned no identity token"])
      return
    }
    var fields: [String: Any] = ["idToken": idToken, "nonce": rawNonce]
    // Apple sends the name on the first sign-in only.
    if let fullName = credential.fullName {
      let name = PersonNameComponentsFormatter().string(from: fullName)
      if !name.isEmpty { fields["name"] = name }
    }
    end(fields)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    if let error = error as? ASAuthorizationError, error.code == .canceled {
      end(["cancelled": true])
    } else {
      end(["error": error.localizedDescription])
    }
  }
}

// Read and written on the main queue only; the controller holds its delegate weakly.
private var activeAppleController: ASAuthorizationController?
private var activeAppleDelegate: AppleSignInDelegate?

private func makeRawNonce() -> String? {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
  return Data(bytes).base64EncodedString()
}

/// Runs the Apple prompt and returns when it ends, as JSON:
/// `{"idToken": "…", "nonce": "<raw>", "name"?: "…"}`, `{"cancelled": true}`, or `{"error": "…"}`.
/// A request still up is cancelled first.
@_cdecl("apple_sign_in_start")
public func appleSignInStart() -> UnsafeMutablePointer<CChar>? {
  guard let rawNonce = makeRawNonce() else { return result(["error": "could not create a nonce"]) }
  let hashedNonce = SHA256.hash(data: Data(rawNonce.utf8)).map { String(format: "%02x", $0) }.joined()

  let done = DispatchSemaphore(value: 0)
  var outcome: [String: Any] = ["error": "the Apple sign-in did not start"]

  DispatchQueue.main.async {
    // A request still up is ended here: the controller holds its delegate
    // weakly, so once replaced it could never report and its caller would wait forever.
    if #available(macOS 13.0, *) {
      activeAppleController?.cancel()
    }
    activeAppleDelegate?.end(["cancelled": true])

    let request = ASAuthorizationAppleIDProvider().createRequest()
    request.requestedScopes = [.fullName, .email]
    request.nonce = hashedNonce

    let controller = ASAuthorizationController(authorizationRequests: [request])
    let delegate = AppleSignInDelegate(rawNonce: rawNonce) { fields in
      outcome = fields
      if activeAppleController === controller {
        activeAppleController = nil
        activeAppleDelegate = nil
      }
      done.signal()
    }
    controller.delegate = delegate
    controller.presentationContextProvider = delegate
    activeAppleController = controller
    activeAppleDelegate = delegate
    controller.performRequests()
  }

  done.wait()
  return result(outcome)
}

/// Ends the Apple prompt that is up, if any. Its `apple_sign_in_start` returns cancelled.
@_cdecl("apple_sign_in_cancel")
public func appleSignInCancel() {
  DispatchQueue.main.async {
    // `cancel()` is macOS 13+ API, and the bridge is built for a 12.0 target.
    if #available(macOS 13.0, *) {
      activeAppleController?.cancel()
    }
  }
}
