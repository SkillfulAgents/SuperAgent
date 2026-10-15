# Paywall and subscription recovery analytics

Events use the existing renderer analytics provider, identity, consent, and configured destinations. E2E mode disables outbound analytics; the browser regression tests replace the SDK adapter with an in-memory sink.

## Correlation

- `paywallId`: random ID for one mounted platform paywall. Shared by its impression, actions, and subscription attempts.
- `attemptId`: new random ID when a provider button is clicked. Sign-in, save, and resume retries within that dialog retain this ID; reopening creates a new attempt.
- `entryPoint`: `platform_paywall`.
- `paywallType`: `subscription` when a new plan is required, otherwise the resolved billing CTA kind (for example `topup`, `add_card`, or `ask_admin`; `none` when unresolved).
- `ctaKind` and `placement`: the billing action and UI placement.

Subscription attempt events also include `provider` (`grok-subscription`, `codex-subscription`, `kimi-subscription`, `minimax-subscription`, or `claude-subscription`), `authMethod` (`device_code` or `setup_token`), and `elapsedMs` since the provider click. The shared analytics provider adds user identity, tenant, app version, and web/Electron metadata as usual.

## General paywall events

| Event | Meaning / extra properties |
| --- | --- |
| `paywall_shown` | Once per mounted wall after billing resolves; includes `blocked`, `live`, and workspace `role`. |
| `paywall_cta_clicked` | External billing link (`surface: external`, `action: open_billing`), iframe fallback (`action: embed_fallback`), or trusted iframe panel open (`surface: embedded`, `action: open_panel`). |
| `paywall_billing_closed` | Trusted iframe message closes the embedded panel. |
| `paywall_recheck_clicked` | User requests a billing refresh. |
| `paywall_dismissed` | User explicitly dismisses a dismissible wall. |
| `paywall_cleared` | Once per wall, with `resolution: billing` or `subscription`. Subscription recovery includes its `attemptId` and `provider`. |

The iframe's `open-billing` message reports a promo/top-up panel opening. It does not expose every checkout click inside the cross-origin frame; `open_panel` must not be interpreted as a completed purchase.

## Existing-subscription funnel

Use `paywall_subscription_options_shown` as the exposure denominator: it is emitted once when the current user can actually use the connection options, never for Top Up or a read-only agent. Join to general paywall events by `paywallId`; both impressions can occur during the same render.

All events below use the `paywall_subscription_` prefix:

| Suffix | Meaning / extra properties |
| --- | --- |
| `clicked` | Provider selected and setup opened; creates the attempt. |
| `sign_in_started` | Device-code sign-in requested; includes `signInAttempt`. |
| `sign_in_opened` | User opens the provider's sign-in link; includes `signInAttempt`. |
| `sign_in_succeeded` | Poll confirms authentication; includes `signInAttempt`. |
| `sign_in_failed` | Start or poll fails; includes `signInAttempt`, `failureStage`, and HTTP status when available. |
| `token_entered` | First nonempty Claude setup token entered. This is input, not proof of authentication. |
| `save_started` | Save submitted; includes `saveAttempt`. |
| `saved` | Connection API confirms the write, before refreshing caches; includes `saveAttempt`. |
| `save_failed` | Save fails; includes `saveAttempt`. |
| `resume_started` | Chat recovery attempted; includes `resumeAttempt`. |
| `resume_failed` | Recovery fails; includes `resumeAttempt` and `failureReason` (`connection_refresh_failed`, `model_unavailable`, `chat_busy`, or `send_failed`). |
| `resumed` | API accepts Continue on the new provider, rather than queueing it; includes `resumeAttempt` and `outcome: message_accepted`. This does not confirm a successful model reply. |
| `cancelled` | Setup is dismissed or unmounted before completion; includes `reason`, `lastStep`, and whether `connectionSaved` was confirmed. A request already in flight can still report its outcome afterwards. |

Recommended conversion funnel: options shown → clicked → sign-in succeeded (device-code providers) or token entered (Claude) → saved → resumed. Group by provider and auth method; use the retry counters to distinguish retries from new attempts. Infer abandoned attempts from missing later steps as well as explicit cancellation: a browser crash or tab close may not deliver an unmount event.

No credentials, device codes, login URLs, account labels, connection names, connection configuration, chat text, or raw error messages are added to these events. Analytics SDK errors must not block the user flow.
