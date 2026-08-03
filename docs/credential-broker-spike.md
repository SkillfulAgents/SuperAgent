# Native browser credential broker spike

This spike adds metadata-only password suggestions to an open `browser_input`
request and a just-in-time autofill path. Apple Passwords is the first provider.
It does **not** execute or link against `apw`; that project was used only as a
reference for the feasibility of Apple Passwords' Chromium extension protocol.

## Architecture

```mermaid
sequenceDiagram
  participant Agent
  participant UI
  participant Host as Host API / credential broker
  participant Extension as Apple Passwords extension
  participant Native as Apple native helper
  participant Browser as Privileged agent browser

  Agent->>Host: request_browser_input (agent blocks)
  Host->>Browser: capture active URL onto request
  Host-->>UI: browser_input request
  UI->>Host: list suggestions (toolUseId)
  Host->>Extension: query hostname over private worker API
  Extension->>Native: encrypted native message
  Native-->>Extension: encrypted account metadata
  Extension-->>Host: usernames/titles/domains only
  Host-->>UI: metadata + opaque, scoped IDs
  UI->>Host: fill selected opaque ID
  Host->>Browser: re-read active URL
  Host->>Extension: retrieve selected account just in time
  Extension->>Native: encrypted native message
  Native-->>Extension: selected secret
  Extension-->>Host: selected username/password
  Host->>Browser: username, password, expected origin
  Browser->>Browser: origin check + DOM fill in one CDP turn
  Browser-->>Host: field-filled booleans only
  Host-->>UI: success (no credential values)
  Host->>Agent: resolve request with submit-login guidance
  Agent->>Browser: click login; request input again if 2FA appears
```

The host discovers the user-installed Apple Passwords Chrome extension and
verifies that its manifest key derives the expected extension ID. It copies the
installed version unchanged (apart from Chrome's `_metadata` directory) into an
app-owned, mode-`0700` runtime directory. It also copies the installed Apple
native-messaging manifest into a dedicated Chrome profile.

The host starts a headless Chrome broker, loads that local extension copy with
`Extensions.loadUnpacked`, attaches to its service worker over loopback CDP, and
invokes the extension's existing PAKE and encrypted native-message functions.
No bridge code is injected into or written over the extension. The broker waits
for Apple's native capabilities handshake before starting PAKE, because that
handshake resets any challenge already in flight.

## Password-manager setup

Provider setup lives in **Settings → Browser Use → Password Managers**, outside
the transient login flow. This is durable configuration only: the user selects
one or more providers from checkbox-style cards, and the provider IDs are saved
under `app.configuredPasswordManagers`. Selecting a provider can start its
local broker for prerequisite validation, but does not pair it or ask for a
verification code.

Enabling a provider performs a host-side prerequisite check before persisting
the selection. Apple Passwords verifies macOS support, Google Chrome, Apple's
native helper, and a valid installed iCloud Passwords extension. A failed check
returns structured remediation for the settings card. Missing-extension setup
includes instructions, a refresh action, and an argument-free Electron action
that opens Apple's exact Chrome Web Store listing directly in Google Chrome.

The login request owns short-lived availability. With no configured provider,
its card shows **Connect Password Manager** and opens Browser Use settings. A
configured and available provider shows its credential candidates immediately.
For Apple Passwords, a configured but disconnected provider shows **Check
Password Manager**. That action starts `ChallengePIN`; Apple Passwords displays
a six-digit code on the Mac, and the user enters it directly in the request card
so the same broker process can complete `PINSet`. The card then refreshes and
shows credential metadata.

The PAKE session is currently in memory for the lifetime of the broker Chrome
process. Restarting the app or broker requires another six-digit challenge. No
Apple password, PIN, or PAKE secret is persisted by Superagent.

## Security properties

- The renderer receives usernames, titles, domains, and opaque random IDs only.
- IDs expire after five minutes, are one-shot, and are bound to the exact agent,
  session, `browser_input` tool call, and origin.
- The host harness captures the active URL onto `browser_input`; the host then
  re-checks the live origin immediately before retrieving a password.
- The browser repeats the expected-origin check in the same JavaScript turn as
  the field mutation, preventing a navigation race from filling another site.
- The agent-container credential endpoints require the existing host token. The
  agent's own shell cannot call them.
- Secrets are not put in a tool result, renderer API response, environment
  variable, process argument, analytics event, or log line.
- Autofill does not submit the form. It resolves `browser_input` with an explicit
  tool result telling the agent to submit the login and request user input again
  if 2FA or another manual step appears.
- Managed providers implement a generic shutdown contract. The shared graceful
  shutdown sequence clears pending selections and stops the Apple broker Chrome.

The password necessarily exists briefly as a JavaScript string in the host API,
the host-to-container request body, and the CDP request. This is an MVP boundary,
not hardware-backed secret isolation.

## Local prerequisites

- macOS with the Apple Passwords native helper installed.
- Google Chrome installed in `/Applications`.
- Apple's iCloud Passwords extension installed in a Chrome-family profile.

No `apw` executable, daemon, environment variable, or separate authentication
terminal is required.

## Spike validation

The native path was exercised on macOS against a locally installed Apple
Passwords extension v3.3.0 and its Apple native helper. The test completed the
six-digit PAKE flow, decrypted an account-list response, selected one candidate,
and decrypted its password. The harness emitted only pairing state, candidate
count, and success booleans; it did not print the matched domain, username, or
password.

## MVP limitations and production work

- macOS and Apple Passwords only.
- The integration depends on Apple's private extension globals and native
  message schema. Pin supported extension versions or add compatibility probes
  before shipping; fail closed when the contract changes.
- The Apple extension is not redistributed. The runtime uses a verified copy of
  the user's own installed extension, but this approach still needs product and
  legal review.
- The broker currently exposes an unauthenticated CDP endpoint on loopback for
  its lifetime. Prefer Chrome's debugging pipe or an authenticated proxy before
  production hardening.
- Top-level document fields only; login forms in cross-origin iframes are not
  filled.
- The heuristic targets a visible password field and the highest-confidence
  username/email field. Passkeys, federated login, and OTP fill are out of scope.
- A two-page login works only if `browser_input` is raised on the relevant page;
  a password-only step fills only the password.
- Production needs stronger extension-update handling, audit events that contain
  no credential metadata, and explicit UX for session expiry.

## Adding 1Password or LastPass

The broker separates metadata listing from just-in-time retrieval through the
`CredentialProvider` interface. A new provider can reuse the API, opaque-ID,
origin-binding, UI, and privileged autofill path.

Prefer a password manager's supported desktop SDK, native messaging API, or CLI
over service-worker introspection. The first lookup should trigger a clear
**Connect** action and let the password manager own account login, unlock,
biometric approval, and inactivity timeout. Browser-extension automation can be
a fallback when no supported interface exists, but it inherits the same private
API and version-compatibility risk as this Apple prototype.
