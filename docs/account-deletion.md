# Account deletion request

Settings → Account offers **Request account deletion** for the connected Gamut
account. App Review guideline 5.1.1(v) requires it of any app that lets people
create an account, and the Gamut sign-in page does.

Nothing is deleted by the app. Confirming sends one event,
`account_deletion_requested`, to the Amplitude project the app's analytics
already use; support's consumer subscribes to that event name, verifies the
account, deletes it and its personal data within 14 days, and emails the
account holder. This is the iOS app's flow and event (its
`docs/account-deletion-event.md` is the contract's first copy, and holds the
consumer's obligations): **change the two together**, and bump `event_version`
when a field changes meaning.

## Pieces

| Where | What |
| --- | --- |
| `src/shared/lib/account-deletion/account-deletion-service.ts` | Builds the event, stores the request, sends it, reads the acknowledgement. |
| `src/shared/lib/account-deletion/account-deletion-schema.ts` | The stored record, the acknowledgement, the status the UI reads. |
| `src/api/routes/account-deletion.ts` | `GET /api/account-deletion` (status), `POST` (send). Resolves the account on the server. |
| `src/renderer/components/settings/account-deletion-section.tsx` | The section at the foot of the Account tab, and its confirmation. |

## The event (version 1)

| Field | Value |
| --- | --- |
| `event_type` | `account_deletion_requested` |
| `user_id` | The Gamut account's id on the platform (`PlatformAuthStatus.userId`) |
| `time` | When the person confirmed, Unix milliseconds; unchanged on retry |
| `insert_id` | The request's UUID; unchanged on retry |
| `session_id` | `-1`: not part of a usage session |
| `platform` | `macos`, `windows`, `linux`, or `web` for a deployment |
| `event_properties.request_id`, `.event_id` | The same UUID: the consumer's deduplication key |
| `event_properties.event_version` | `1` |
| `event_properties.workspace_url` | Where the account lives: the platform's base URL, without credentials, query or fragment |
| `event_properties.tenantId`, `groups.tenantId` | This install's tenant id, when it has one |
| `event_properties.source`, `.surface` | `client`, `app`, as on iOS |
| `event_properties.platform` | Same as `platform` |

**What differs from iOS.** The iOS app is signed in to a workspace, so its
`user_id` is that workspace's account id and `workspace_url` the workspace's
address. The desktop app's account is the Gamut account itself, so `user_id`
is the platform's user id and `workspace_url` the platform's base URL. The
consumer's rule is the same either way: resolve the account by
**workspace_url + user_id**, and act only on addresses it knows.

No email, name, token or device id is sent. Account and tenant ids are checked
to be opaque ids before anything is stored (`opaqueIdSchema`), so content, a
URL, an email or an API key can't enter the event.

## Rules the code keeps

- **It is not analytics.** It is sent whatever `shareAnalytics` says, through
  its own request, with none of the analytics metadata. The confirmation says
  so.
- **The server names the account.** The request carries the account id the
  person was shown, and the server sends only if that is still the connected
  account (409 otherwise). An organization key with no person behind it has no
  account to delete, and the section does not appear.
- **Stored before it is sent.** The request is an app record,
  `account-deletion-request:<userId>`, inserted if absent, so concurrent
  confirmations and every retry (after a timeout, an error, a restart) send the
  same `request_id`, never a second request.
- **Sent means acknowledged.** Only HTTP 200 with `code: 200` and
  `events_ingested: 1` marks the request accepted. That proves Amplitude took
  the event, not that support was notified or the account deleted.
- **The key is public**, so the event is not proof of who asked. The consumer
  verifies the account before deleting anything.

## Before a release

The consumer and the support process behind it are outside this repository.
Send one real request from a test account and follow it through Amplitude →
consumer → support work item → deletion → confirmation email.
