# Agent email (SUP-877)

An agent owner can add **Email** from the agent's **External Integrations** section when the deployment is connected to Platform. Choose the sender display name, a unique inbox name, and an access level. The gateway provisions `<inbox>@<company>.ongamut.so` and configures the company domain on first use. DNS verification can take several minutes. Renaming changes the sender display name; the address and mailbox binding remain fixed. Deleting disables the gateway mailbox; addresses remain reserved.

| Access level | Who can initiate email | Who the agent can email |
| --- | --- | --- |
| Agent users only | Verified agent users/owners and deployment administrators | The same users |
| Agent users + replies (default) | Agent users, plus recipients replying in a thread the agent previously emailed | Anyone |
| Allowed domains only | Addresses in the configured exact domains | The same domains |
| Anyone | Anyone, subject to the unsolicited-mail review filter | Anyone |

Protected modes require DMARC `pass` from the provider's API attestation. Sender-supplied headers do not count. Subdomains must be listed explicitly. A valid email is not an authenticated app session: email can answer a single clarification question, but privileged approvals and multi-question forms require the app. Every outbound To/Cc/Bcc and Reply-To destination is checked against the current policy. Narrowing access or pausing stops subsequent replies.

Anyone mode uses a conservative local heuristic for unknown senders; flagged content and unsolicited attachments are held for owner review in Email Settings. This is not a complete prompt-injection detector. Release is owner-only, audited, and still subject to the current access policy. No extra screening model call is made.

## Architecture and identity

`EmailAgentIntegration` implements generic admission, thread sessions, input framing, questions, final-response delivery and attachments. `PlatformEmailAgentIntegration` supplies Platform availability, the standalone gateway transport and mailbox identity checks. The existing integration registry and manager own lifecycle/session orchestration; there is no Platform-side mail adapter.

The gateway origin is fixed. Credentials are resolved server-side for every request and SSE reconnect, with the creating Platform member's attribution. Neither bearer credentials nor provider keys are saved in integration configuration or exposed to the renderer. The gateway verifies organization/member ownership on every mailbox operation. Atomic local duplicate checks and gateway address reservations prevent two agents from sharing an inbox.

For an organization runtime JWT, first-time domain discovery additionally uses the owner's refreshable Platform OAuth token in `X-Platform-Discovery-Token`; the gateway constrains the result to the JWT's organization. Existing enrolled domains do not require that extra token. A deployment with no saved owner OAuth credential must have the owner sign in with Platform again before first enrollment. The gateway prerequisite is version 0.2.2 (migration `0003_sender_authentication.sql`). Older inbound messages have no provider attestation and fail closed in protected modes.

## Consumption and delivery

One shared, authenticated SSE subscription per Platform member wakes the mailbox consumers. Per-integration polling with a durable cursor is authoritative and recovers missed events after reconnect; the fallback interval is 30 seconds. A mail thread has one persistent agent session, without chat-style idle rotation. Late thread reconciliation retries previously unaccepted replies and retains an existing inbound route when the canonical thread has no session. If both threads already have histories, subsequent messages follow the canonical thread; existing transcripts are not merged.

Inbound attachments are fetched through the authorized gateway into the agent workspace. Only the final response is sent; progress and tool chatter are suppressed. `deliver_file` adds attachments to that response. The gateway handles sender names, MIME, quoting and RFC threading. Automatic replies target the sender/Reply-To; explicit reply-all adds checked To/Cc, never inherited Bcc.

For proactive sends, `list_chat_integrations` advertises `send_email`; `send_chat_message` accepts:

```json
{
  "integration_id": "<integration id>",
  "message": "Here is the report.",
  "email": {
    "to": ["colleague@example.com"],
    "cc": [],
    "bcc": [],
    "subject": "Weekly report",
    "attachment_paths": ["/workspace/report.pdf"],
    "idempotency_key": "weekly-report-2026-09-22"
  }
}
```

Use `reply_to_message_id` for a reply. Keys contain letters, numbers, dots, underscores, colons or hyphens. Retries preserve attachment IDs and reject changed content under the same key. The result exposes message/thread IDs and queued status; acceptance is not proof of delivery. A session's final response already replies to its own email thread, so the tool rejects an explicit duplicate reply there. Automated integration provisioning is not exposed to agents.

## Persistence and known boundary

Migration `0048_email_integration_state.sql` stores poll cursors, thread admission state, held-mail review, upload/send intents and delivery receipts. State uses awaited, conditional SQL compatible with SQLite and libSQL/D1. Email and gateway retention remain indefinite.

Inbound acceptance now uses the shared durable delivery engine introduced in SUP-922. The provider advances its cursor only after the manager persists the event; retries use stable message IDs. Owner releases and late reconciliation use distinct stable delivery IDs so the manager can reconsider a previously filtered message. Runtime execution still cannot be claimed to be exactly once across every external side effect. Final email sends use gateway idempotency keys and durable delivery receipts to suppress duplicates.


## Validation

Focused tests cover all four policies, spoofed authentication, current ACLs, immutable/duplicate inboxes, owner-only configuration, CC/BCC/Reply-To, final-only delivery, attachments and retry idempotency, held review, questions versus approvals, polling recovery, thread reconciliation, shared SSE and fresh credentials. Database tests also run with `DB_DRIVER=libsql`. UI setup/settings are reviewed in light and dark themes.

A controlled live test on 2026-09-22 exercised the concrete integration against the deployed gateway using owned pilot mailboxes: send + CC, authenticated receive, attachment download, default-policy reply admission, live/poll notification, a bounded Haiku call and a threaded reply with duplicate-delivery suppression. This tested the integration transport with model output, not a full agent-container session. Gateway 0.2.2 was deployed after a verified private R2 backup.
