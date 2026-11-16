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
/// An `ephemeral` session shares no cookies with the person's browser.
@_cdecl("web_auth_start")
public func webAuthStart(_ urlText: UnsafePointer<CChar>, _ schemeText: UnsafePointer<CChar>, _ ephemeral: Bool) -> UnsafeMutablePointer<CChar>? {
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
    // Otherwise the person's browser session carries over, so someone already
    // signed in on the web is not asked for their password again. The Apple
    // hand-off is ephemeral: its token decides who signs in, and the platform
    // page keeps any session it finds in place of the token.
    session.prefersEphemeralWebBrowserSession = ephemeral
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
  private let answer: ([String: Any]) -> Void
  private let settled: () -> Void
  // Main queue only. Apple and a cancel can both end the same request.
  private var answered = false

  /// `answer` gets the outcome once, for the waiting caller; `settled` runs
  /// when Apple reports, which on macOS 12 can be long after a cancel answered.
  init(rawNonce: String, answer: @escaping ([String: Any]) -> Void, settled: @escaping () -> Void) {
    self.rawNonce = rawNonce
    self.answer = answer
    self.settled = settled
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    appWindow()
  }

  func end(_ fields: [String: Any]) {
    guard !answered else { return }
    answered = true
    answer(fields)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    defer { settled() }
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
    defer { settled() }
    if let error = error as? ASAuthorizationError, error.code == .canceled {
      end(["cancelled": true])
    } else {
      end(["error": error.localizedDescription])
    }
  }
}

// Read and written on the main queue only. Both are kept until Apple reports,
// even once a cancel has answered the caller: the controller holds its delegate
// weakly, and on macOS 12 its prompt stays up until the person dismisses it.
private var activeAppleController: ASAuthorizationController?
private var activeAppleDelegate: AppleSignInDelegate?

/// Answers the caller of the Apple request that is up, if any, as cancelled,
/// and closes its prompt. Main queue only. `cancel()` is macOS 13+ API and the
/// bridge targets 12.0, where the prompt stays until the person dismisses it
/// and what they choose there is dropped.
private func endActiveAppleRequest() {
  if #available(macOS 13.0, *) {
    activeAppleController?.cancel()
  }
  activeAppleDelegate?.end(["cancelled": true])
}

private func makeRawNonce() -> String? {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
  return Data(bytes).base64EncodedString()
}

/// Runs the Apple prompt and returns when it ends, as JSON:
/// `{"idToken": "…", "nonce": "<raw>", "name"?: "…"}`, `{"cancelled": true}`, or `{"error": "…"}`.
/// A request still up is cancelled first. On macOS 12, where its prompt cannot
/// be closed, this returns an error instead until the person dismisses it.
@_cdecl("apple_sign_in_start")
public func appleSignInStart() -> UnsafeMutablePointer<CChar>? {
  guard let rawNonce = makeRawNonce() else { return result(["error": "could not create a nonce"]) }
  let hashedNonce = SHA256.hash(data: Data(rawNonce.utf8)).map { String(format: "%02x", $0) }.joined()

  let done = DispatchSemaphore(value: 0)
  var outcome: [String: Any] = ["error": "the Apple sign-in did not start"]

  DispatchQueue.main.async {
    if activeAppleController != nil {
      endActiveAppleRequest()
      // No second prompt over one macOS 12 cannot close.
      guard #available(macOS 13.0, *) else {
        outcome = ["error": "a Sign in with Apple prompt is still open"]
        done.signal()
        return
      }
    }

    let request = ASAuthorizationAppleIDProvider().createRequest()
    request.requestedScopes = [.fullName, .email]
    request.nonce = hashedNonce

    let controller = ASAuthorizationController(authorizationRequests: [request])
    let delegate = AppleSignInDelegate(
      rawNonce: rawNonce,
      answer: { fields in
        outcome = fields
        done.signal()
      },
      settled: { [weak controller] in
        // A newer request may already have replaced this one.
        if let controller, activeAppleController === controller {
          activeAppleController = nil
          activeAppleDelegate = nil
        }
      }
    )
    controller.delegate = delegate
    controller.presentationContextProvider = delegate
    activeAppleController = controller
    activeAppleDelegate = delegate
    controller.performRequests()
  }

  done.wait()
  return result(outcome)
}

/// Ends the Apple prompt that is up, if any. Its `apple_sign_in_start` returns
/// cancelled at once, on macOS 12 too, where the prompt itself stays up.
@_cdecl("apple_sign_in_cancel")
public func appleSignInCancel() {
  DispatchQueue.main.async {
    endActiveAppleRequest()
  }
}
