# Agent email (SUP-877)

An agent owner can add **Email** from the agent's **External Integrations** section when the deployment is connected to Platform. Choose the sender display name, a unique inbox name, and an access level. The gateway provisions `<inbox>@<company>.ongamut.so` and configures the company domain on first use. DNS verification can take several minutes. Renaming changes the sender display name; the address and mailbox binding remain fixed. Deleting disables the gateway mailbox; addresses remain reserved.

| Access level | Who can initiate email | Who the agent can email |
| --- | --- | --- |
| Agent users only | Verified agent users/owners and deployment administrators | The same users |
| Agent users + replies (default) | Agent users, plus recipients replying in a thread the agent previously emailed | Anyone |
| Allowed domains only | Addresses in the configured exact domains | The same domains |
| Anyone | Anyone | Anyone |

Protected modes require DMARC `pass` from the provider's API attestation. Sender-supplied headers do not count. Subdomains must be listed explicitly. A valid email is not an authenticated app session: email can answer a single clarification question, but privileged approvals and multi-question forms require the app. Every outbound To/Cc/Bcc and Reply-To destination is checked against the current policy. Narrowing access or pausing stops subsequent replies.

Anyone mode admits unsolicited mail under the same integration lifecycle. There is no separate held-mail review queue. Bodies, quoted history and attachments are framed as untrusted input, and email cannot approve privileged actions.

## Architecture and identity

`EmailAgentIntegration` implements generic admission, thread sessions, input framing, questions, final-response delivery and attachments. `PlatformEmailAgentIntegration` supplies Platform availability, the standalone gateway transport and mailbox identity checks. The existing integration registry and manager own lifecycle/session orchestration; there is no Platform-side mail adapter.

The gateway origin is fixed. Credentials are resolved server-side for every request and SSE reconnect, with the creating Platform member's attribution. Neither bearer credentials nor provider keys are saved in integration configuration or exposed to the renderer. The gateway verifies organization/member ownership on every mailbox operation. Atomic local duplicate checks and gateway address reservations prevent two agents from sharing an inbox.

For an organization runtime JWT, first-time domain discovery additionally uses the owner's refreshable Platform OAuth token in `X-Platform-Discovery-Token`; the gateway constrains the result to the JWT's organization. Existing enrolled domains do not require that extra token. A deployment with no saved owner OAuth credential must have the owner sign in with Platform again before first enrollment. The gateway prerequisite is version 0.2.2 (migration `0003_sender_authentication.sql`). Older inbound messages have no provider attestation and fail closed in protected modes.

## Consumption and delivery

One shared, authenticated SSE subscription per Platform member wakes the mailbox consumers. Per-integration polling with a durable cursor is authoritative and recovers missed events after reconnect; the fallback interval is 30 seconds. A mail thread has one persistent agent session, without chat-style idle rotation. Gateway thread redirects are resolved against existing shared session mappings, retaining an inbound route when the canonical thread has no session. If both threads already have histories, subsequent messages follow the canonical thread; existing transcripts are not merged.

Inbound attachments are fetched through the authorized gateway into the agent workspace. At turn completion, the configured summarizer model composes a complete plain-text email from all assistant text blocks and a bounded email-chain window. This preserves an answer that precedes a monitor acknowledgment. It can suppress monitor-only or already-sent follow-ups. Thinking and tool results are excluded. A malformed or unavailable model response is reported through the integration error path; it never falls back to sending the last monitor acknowledgment. `deliver_file` adds attachments to that response. The gateway handles sender names, MIME, quoting and RFC threading. Automatic replies target the sender/Reply-To; explicit reply-all adds checked To/Cc, never inherited Bcc.

For proactive sends, `list_agent_integrations` advertises `send_email`, `list_users`, and `list_channels`; `send_chat_message` accepts:

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

Use `reply_to_message_id` for a reply. Keys contain letters, numbers, dots, underscores, colons or hyphens. A bounded process-local cache reuses attachment IDs for recent retries and rejects changed content under the same key. The gateway enforces send idempotency. After a restart or cache eviction, attachment reuploads can cause the gateway to reject reuse of an earlier key; inspect the gateway result before initiating a new send. The result exposes message/thread IDs and queued status; acceptance is not proof of delivery. A session's final response already replies to its own email thread, so the tool rejects an explicit duplicate reply there. Automated integration provisioning is not exposed to agents.

## Contact and conversation discovery

`list_chat_users` returns up to 100 deduplicated email contacts, labeled `workspace` or `previous-correspondence`. Workspace contacts are verified, non-banned members (the connected owner in single-user mode). Both sources are filtered by the current outbound policy and exclude the agent's own address. Historical contacts come only from this mailbox. Use the returned `email` in `send_chat_message.email.to`, not `user_id`.

`list_chat_channels` returns at most **20** eligible email conversations with subject, allowed participants and `replyToMessageId`. Use that ID as `email.reply_to_message_id`, not `chat_id`. Results are ordered by the latest eligible message found. Discovery scans up to 50 recently created gateway threads and the first 100 messages per thread, plus up to 1,000 workspace members. A `truncated` result signals that the listing is incomplete. This is bounded discovery, not a full-mailbox search; an old thread with new activity may fall outside the window. The send path always checks current policy again, including every reply-all recipient.

## Persistence and known boundary

Email adds no tables or migrations. Its one polling cursor is stored in the existing integration configuration; only that JSON field is updated, preserving concurrent settings edits. Shared integration sessions own the agent/thread mapping, and the gateway owns messages, attachments, thread redirects and outbound send jobs. Slack persistence is unchanged.

Inbound acceptance uses the shared durable delivery engine introduced in SUP-922. The provider advances its cursor only after the manager persists the event; retries use stable message IDs. The shared engine owns inbound deduplication, retries and recovery. Thread-reconciliation notifications do not enqueue the same message a second time: a reply denied before late threading information arrives is not automatically reconsidered. The sender can send a new reply after reconciliation.

Assistant text is buffered in memory until completion and composed once. Email has no separate outbound recovery queue, saved drafts or delivery receipts. A host restart can lose the current output buffer; composer or gateway submission failures are reported but are not automatically retried by the inbound queue. Once the gateway accepts an email, its existing send jobs own provider delivery. Durable recovery of agent output before gateway acceptance belongs in a shared integration-framework follow-up, not an email-specific persistence layer. Runtime execution cannot be claimed to be exactly once across external side effects.

Gateway retention remains indefinite. Shared input receipts use the existing framework's retention policy.

## Validation

Focused tests cover all four policies, spoofed authentication, current ACLs, immutable/duplicate inboxes, owner-only configuration, CC/BCC/Reply-To, final-only delivery, attachments and process-local retry idempotency, questions versus approvals, multi-block email composition, monitor-only suppression, failure reporting, policy-filtered contact discovery, capped conversations, polling recovery, concurrent settings updates, gateway thread redirects, shared SSE and fresh credentials. Database tests also run with `DB_DRIVER=libsql`. UI setup/settings are reviewed in light and dark themes.

A controlled live test on 2026-09-22 exercised the concrete integration against the deployed gateway using owned pilot mailboxes: send + CC, authenticated receive, attachment download, default-policy reply admission, live/poll notification, a bounded Haiku call and a threaded reply with duplicate-delivery suppression. This tested the integration transport with model output, not a full agent-container session. Gateway 0.2.2 was deployed after a verified private R2 backup.

The composer was additionally checked with three live configured-model calls: preserving an answer before a monitor acknowledgment, suppressing a monitor-only follow-up, and retaining a later correction plus an attachment reference. These checks did not send email.
