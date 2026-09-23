# SUP-877 — Agent Emails: working specification

Status: code-grounded draft for discussion, 2026-09-21. Confirmed choices are marked below; other proposals remain open. No feature code has changed. Shared input reliability is separately tracked in [SUP-912](https://linear.app/datawizz/issue/SUP-912/make-integration-input-acceptance-durable-across-native-connectors-and).

**Current service boundary:** an independently deployed Email Gateway owns the email API, provider integration, database, storage, jobs, quotas, and domain provisioning. SuperAgent calls it directly. Platform supplies identity validation only; there is no platform-side email adapter or shared platform database dependency. Resend with conservative limits is the current MVP proposal, not a finalized provider decision. See [managed service research](SUP-877-email-provider-research.md); SES/Lambda remains a possible gateway-internal backend.

Sources: [SUP-877](https://linear.app/datawizz/issue/SUP-877/feature-agent-emails), [shared research](https://chatgpt.com/share/6aac23b0-b47c-83e8-9b9d-156075323bd5), the SuperAgent checkout, and `/home/iddogino/Code/platform`.

## Product contract

An agent owner manually adds an Email integration and chooses an available mailbox name. The Email Gateway provisions a stable address. People can email the agent, and the agent can initiate email conversations through its integration tools. One mailbox thread maps to one agent conversation.

Confirmed requirements (including subsequent discussion):

- Platform connection required; no independent email provider in V1.
- `EmailAgentIntegration extends AgentIntegration`; concrete `PlatformEmailAgentIntegration extends EmailAgentIntegration` implements the client transport to the standalone, platform-authenticated Email Gateway.
- Mailbox name chosen at setup, independent of agent display name and internal agent identifier.
- A standalone Email Gateway owns all email operations and data. SuperAgent connects directly to its API. Cloudflare Workers is a proposed hosting runtime for that separate service, not a module inside the platform proxy. Platform is used only to establish caller identity and current credential validity.
- Four permission modes: Agent Users Only; Agent Users + Replies (default); Allowed Domains Only; Anyone. The default admits agent users and replies to agent-initiated outbound conversations.
- Provider choice is being revisited for a conservative Resend MVP. The earlier SES Tenants decision applies if SES is selected; it is not a feature we can claim for Resend.
- Manual integration creation only. General automatic integration provisioning is out of scope. Provisioning mail infrastructure after a user adds Email is necessary V1 work.

Proposed scope: any platform-connected installation, including desktop and self-hosted deployments. The Email Gateway receives mail while the installation is offline; execution resumes when its assigned installation reconnects. Platform connectivity does not imply an always-running agent. Cloud-only scope remains an open choice.

## What the code already supports

| Area | Finding | Spec consequence |
| --- | --- | --- |
| Integration abstraction | `src/shared/lib/agent-integrations/agent-integration.ts` provides authorization, routing, input preparation, delivery, and tools. `types.ts` separates the logical external ID from the reply target. | Implement email as its own family. Do not inherit chat streaming and interactive-card requirements. |
| Registration and persistence | `registry.ts` registers chat providers. `store.ts` adapts the existing `chat_integrations` and `chat_integration_sessions` tables. API validation and setup still enumerate chat providers. | Add provider/family-aware setup, validation, serialization, and persistence support; registering a class alone is insufficient. Existing table names need not be renamed for V1. |
| Session routing | The session service persists integration + external conversation ID → session ID, with optional timeout rotation. | Use mailbox-scoped thread IDs and disable automatic timeout rotation for email. Explicit context clearing needs a defined exception. |
| Delivery acknowledgment | `agent-integration-manager.ts:801` queues input in memory; event receipt does not await durable processing. Session creation starts a run before recording the integration/session mapping. | Shared durable acceptance and runtime recovery are separate work in SUP-912. Telegram, Slack, and iMessage share this handoff. Email retains mailbox persistence and replay; SUP-877 does not absorb the common refactor. |
| Execution identity | `agent-integration-manager.ts:823` executes inbound work in the integration creator's user context. | External mail invokes an agent with existing capabilities. Sender admission, execution authority, and audit attribution must be explicit. |
| Access controls | `chat-integration-access-service.ts:37` permits non-Telegram integrations; its approval mechanism is Telegram-specific. Agent ACLs live in `src/api/middleware/auth.ts`. | Implement email-specific inbound and outbound policy. Organization membership alone is not equivalent to permission to invoke a particular agent. |
| Outbound tool | `agent-container/src/tools/chat/send-chat-message.ts` and `src/api/routes/x-agent-chat.ts` accept text and chat/user IDs. | Add structured email recipients, subject, attachments, and reply/thread identifiers, preserving the existing protection against sending twice into the active conversation. |
| Platform authentication | `packages/shared/src/runtime-auth.ts` and `apps/proxy/src/auth.ts` support org runtime JWTs and member platform tokens. Org tokens may have no expiry; validity includes an active-key database check. `/v1/account` supports member tokens and org JWTs with an acting member. | Consume a platform identity API from the standalone gateway. Do not copy platform database access into it or treat signature verification as current authorization. Org-only runtime introspection needs a small identity-contract extension. |
| Standalone gateway precedent | `imessage-connector.ts` uses a configured `gatewayUrl` and bearer token and connects directly to the gateway WebSocket. | Keep the email integration as a client of a separately operated service. This confirms the client boundary; the iMessage gateway server implementation was not present in the inspected paths. |
| Domain identity | Platform `apps/web/src/lib/cloud-slug.ts` uses a configurable ingress domain (fallback `ongamut.ai`). `org_deployment` has deployment-specific URLs and renameable desired hostnames. | Do not hardcode `ongamut.so`, derive addresses repeatedly from organization names, or assume every connected org has a cloud hostname. Persist a separate stable mail-domain assignment. |

## Standalone Email Gateway and platform identity

The Email Gateway is independently versioned and deployed, with its own API origin, provider credentials, configuration, database/migrations, object storage, queues, operational controls, and tests. It can run on Cloudflare Workers while remaining separate from the platform application. A separate service repository is the proposed packaging. The exact database/storage engine is an implementation choice; it must not read platform auth tables or require a platform Supabase service-role key, shared schema, or cross-service database joins.

SuperAgent calls the gateway directly for setup, reads, sends/replies, attachments, polling, claims/acknowledgments, and subscriptions. Resend webhooks go directly to the gateway's provider-ingestion endpoint. Platform neither proxies those operations nor hosts a Resend adapter. If provider-specific code is factored internally, it belongs exclusively to the gateway; a multi-provider abstraction is not required for the MVP.

The app-side `EmailAgentIntegration` / `PlatformEmailAgentIntegration` hierarchy is retained. The latter is the SuperAgent client of this platform-identified gateway, not a class or adapter inside the platform repository. Its configuration refers to the gateway URL and its mailbox binding. The gateway API exposes stable service-owned IDs rather than requiring clients to use Resend IDs.

### Recommended MVP identity contract: outbound validation

1. The SuperAgent backend sends its supported platform credential to the configured gateway over HTTPS. Provider keys remain gateway secrets. Do not accept a caller-supplied org ID as authority.
2. The gateway calls a fixed, trusted platform identity endpoint. Platform validates the credential, active/revoked state, and applicable member/org status, then returns a typed principal: org ID, subject/principal kind, and member/user/role context where present. Supplied acting-member context is validated by platform. Installation identity must not be inferred from an arbitrary request field; an installation binding needs a service-issued credential or a separately authenticated enrollment contract.
3. The gateway applies its own mailbox ownership, resource permissions, policy, and quota rules using that principal. Platform proves identity; it does not decide email-specific operations or agent ACLs. SuperAgent continues to enforce its local agent ACLs and execution authority.
4. For the initial implementation, perform online validation for protected operations without an additional gateway auth cache. An identity-service failure or failed validation cannot turn into anonymous or unscoped access. Return an auth-unavailable error when platform cannot validate the caller; preserve queued mail. Revalidate long-lived subscriptions periodically and before delivering protected data/accepting further operations. The interval and platform's own cache behavior define the revocation bound and must be specified before launch.

Existing platform `GET /v1/account` is a starting point: opaque member tokens are checked, and org JWTs work with validated acting-member context. It currently rejects org JWTs without an acting member. A minimal general identity/introspection endpoint (proposed, not existing) should expose the current auth machinery for both member and org-runtime principals, without display-field lookups or email-specific logic. Its cache/revocation semantics must be explicit; calling platform does not automatically guarantee immediate revocation.

### Optional later optimization: short-lived service JWTs

If online validation becomes a latency/availability issue, platform can exchange existing valid credentials for a short-lived, audience-bound gateway JWT (for example `aud=email-gateway`, `exp` five minutes). Gateway verifies trusted issuer, signature/JWKS, audience, expiry, and required identity claims locally. Platform checks active credentials and membership before issuance/refresh. This needs an explicit token-exchange contract; existing org-runtime JWTs must not simply be reinterpreted as email-service tokens.

Offline JWT verification permits access until token expiry after a revocation. Refresh fails for revoked identities; stricter revocation would require online checks or revocation propagation. A valid platform identity is still subject to gateway-owned mailbox permissions. The gateway never receives platform signing secrets or auth-database credentials.

### Availability and ownership

Provider receipt and durable ingestion for existing mailboxes continue during a platform identity outage: Resend webhook authentication is a separate service-to-service contract. New authenticated setup/read/send/claim operations require successful identity validation under the chosen contract. Existing durable outbound intents use a bounded authorization lifetime and are revalidated after a long delay; deciding queue behavior must not require retaining broad, long-lived user bearer credentials. Email Gateway owns mailbox lifecycle, delivery status, limits, and sender/recipient policy; platform's only integration responsibility is its generic identity contract.

## Mailbox identity and lifecycle

Proposed Email Gateway record: `mailboxId`, authenticated `orgId`, `mailDomainId`, canonical `localPart`, owning installation ID, integration ID, agent ID, policy/version, and provisioning/lifecycle status. The address is unique within its mail domain; the IDs remain stable across display-name changes.

- Setup suggests a slug, allows editing before creation, and reports a collision without silently selecting another address.
- Creation is idempotent. Repeating a setup request recovers the same mailbox, including after partial provisioning failures.
- DNS, DKIM, and provider identity setup can be asynchronous: expose provisioning, ready, and actionable failure states. Do not advertise a usable address before inbound and outbound are ready.
- Pause preserves the address and queued mail but prevents new agent execution and sends. Resume rechecks policy before processing backlog.
- Delete disables routing and sending. Proposed V1 rule: do not automatically reassign deleted addresses to another agent; stale replies must not reach a new owner.
- Agent duplication/export must not clone a live mailbox binding. Installation reassignment is explicit; two installations must not independently consume the same mailbox.
- Workspace or agent rename leaves the mail address unchanged. Mailbox renaming/aliases are out of scope unless explicitly added.

## Message and thread contract

The Email Gateway owns normalized message IDs, thread IDs, parsed-message handling, attachments, and email headers. The app owns agent session history and execution.

1. Scope all threading to the destination mailbox. Match `In-Reply-To` to a known message, then recognized `References`. Subject similarity alone never joins conversations.
2. No recognized parent means a new thread, subject to sender admission. Missing, malformed, ambiguous, or conflicting references must not merge unrelated sessions.
3. Thread recognition is routing, not authorization. A forged reference does not admit a sender or expose an existing conversation.
4. A proactive outbound email creates a gateway thread and an app session mapping. Record its content and optional internal context without triggering an assistant turn. Replies resume that conversation.
5. Internal message IDs, RFC Message-ID headers, and provider delivery IDs are separate fields. Round-trip tests must prove that actual delivered IDs resolve correctly. In the SES alternative, SES replaces supplied Message-ID headers. [SES header behavior](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html)
6. A context clear creates a fresh app session for the same email thread; previous app context is not silently restored. This is the explicit exception to one thread/one session. A missing runtime session follows the same documented recovery behavior.
7. Do not send intermediate tokens, tool traces, typing indicators, or partial assistant messages. Deliver a completed response once. Collect attachments for that response into its email.
8. Proposed reply behavior: reply to the sender by default; support explicit reply-all with recipient checks. Never expose Bcc recipients, add quoted addresses automatically, or trust a changed Reply-To to bypass policy. To/Cc/Bcc scope needs confirmation.
9. Automated responses, bounces, and delivery reports do not start ordinary agent turns by default. Add loop prevention for automatic messages and repeated exchanges.

## Permissions and untrusted input

These rules apply both to initial admission and again before delivery/execution when policy or access may have changed.

| Mode | Inbound | Outbound |
| --- | --- | --- |
| Agent Users Only | Senders corresponding to verified identities currently allowed to invoke this agent. | Only those same permitted identities. |
| Agent Users + Replies **(default)** | Agent users can initiate. External senders may reply within a thread where the agent previously contacted that sender. | Agent users and external recipients. |
| Allowed Domains Only | Anyone whose authenticated sender domain is allowlisted; no agent ACL entry required. | Only recipients in the configured domains (the internal-only interpretation). |
| Anyone | Any sender can initiate, subject to abuse controls and filtering. | Agent users and external recipients. |

Proposed interpretation of “Agent Users”: current `user`-or-higher agent permission, plus applicable admin access; viewer-only access is insufficient. In non-auth mode, use the connected platform user's verified address as the baseline, rather than pretending there is an agent ACL. Additional allowed identities need an explicit product decision.

For Agent Users + Replies, a previous outbound message grants reply eligibility within that conversation, not indefinite permission to initiate unrelated threads. A newly added participant must independently satisfy admission rules.

Allowed Domains Only is an internal-only boundary: external agent-user addresses and external replies do not bypass it. Interpreting “internal emails only” as restricting both sending and receiving. Proposed matching: canonicalized, case-insensitive exact domains, with subdomains explicitly listed. Require a nonempty list and check all recipients, including Cc/Bcc and Reply-To destinations. Matching details remain a proposal.

Email From text is not authentication. Define an inbound provider-attested authentication policy for protected identities; never trust sender-supplied Authentication-Results headers. Domain authentication alone is not equivalent to an authenticated app session. Failed/unsupported identity evidence must not grant privileged access. A proof-of-address flow may be needed for providers where the chosen checks are insufficient; this is an implementation spike before declaring Agent Users Only complete.

Keep external sender identity distinct from the principal whose capabilities the agent uses. Proposed V1 execution behavior preserves the configured integration principal, records the sender separately, and makes the authority granted by Anyone clear at setup. Owner-only controls govern publishing a mailbox and changing its policy. The agent's own tools cannot loosen its email policy.

Treat bodies, quoted history, attachments, and external links as untrusted input in every mode. In Anyone mode, unsolicited messages pass a prompt-injection filter before any run; suspicious results are held for owner review. Proposed failure behavior is to hold mail if the filter is unavailable. A passing result does not authenticate the sender or authorize actions. There is existing external-input framing in `scheduler/trigger-manager.ts`, but the inspected path does not provide an email classifier.

Retain existing tool approval requirements. External email cannot approve privileged actions just by replying “yes.” Route approval requests to the authenticated app; ordinary clarification questions can be answered by email. Do not expose actionable approval links to recipients without independent app authorization.

The Email Gateway enforces tenant scope, mailbox ownership, sending limits, suppression, and mailbox recipient policy. Platform validates calling identities only. The app enforces agent ACLs and execution permissions. If gateway policy needs app-local ACL data, define an authenticated, versioned synchronization and expiry contract directly between SuperAgent and the gateway; stale membership data must not keep Agent Users Only access alive indefinitely.

## Reliable transport and storage

Scope split: [SUP-912](https://linear.app/datawizz/issue/SUP-912/make-integration-input-acceptance-durable-across-native-connectors-and) owns common application acceptance, native-connector migration, and uncertain runtime handoff recovery. [SUP-871](https://linear.app/datawizz/issue/SUP-871/shared-webhook-relay-service-realtime-delivery-capability-discovery) owns shared relay connectivity and claim/ack scheduling. Neither common refactor is bundled into SUP-877. Email owns mailbox persistence, stable message/event IDs, replay/cursors, and outbound state. Integrate with a durable acceptance seam when available; until then document the inherited application crash window rather than claim end-to-end lossless execution.

Architecture direction: the standalone Email Gateway owns authoritative relational metadata, private content/attachment storage, and durable ingestion/outbound work. A separate Cloudflare Worker is the proposed API runtime. In the Resend proposal, it accepts authenticated provider webhooks, durably records receipt, retrieves parsed content, and publishes normalized mailbox records/events. Durable Objects may coordinate subscriptions or consumption; they do not replace receipt history. Platform database/schema access is not part of this architecture.

Minimum service operations:

- Create, get, pause/resume, and disable a mailbox; inspect domain/provisioning readiness.
- Submit an email with `mailboxId`, `to`, optional `cc`/`bcc`, subject, Markdown body, attachment handles, optional reply message ID, and an idempotency key. Derive From, authenticated org, provider sending identity, and thread inside the gateway.
- Poll events for an authorized set of mailbox IDs with pagination and a durable resume cursor.
- Expose stable delivery IDs and an acknowledgment/claim contract for one assigned consumer. Polling or receiving notifications must not delete mailbox messages. Common durable application acceptance belongs to SUP-912.
- Subscribe for notifications across that same mailbox set. Proposed V1: one multiplexed SSE connection per installation, with polling/replay as the source of truth. WS and outbound webhooks are not additional V1 requirements.
- Read authenticated thread/message metadata and private attachments; inspect delivery status.

Inbound: persist the message and event before reporting mailbox receipt; deduplicate gateway ingestion retries and support replay. Common durable app acceptance and dispatch recovery belong to SUP-912. Mailbox receipt must not be presented as completed agent processing. Preserve message-specific reply targets across overlapping inputs.

Outbound: persist intent before calling the provider. Retrying the same API request returns the original message/status. Final-turn delivery uses a stable response identifier. If the provider may have accepted a send but the response was lost, record an uncertain state and reconcile using delivery events where possible; do not promise exactly-once SMTP delivery or blindly resend.

SUP-912 covers the second crash window: a run may start before its session mapping or input receipt is recorded. A local inbox alone does not resolve uncertain runtime submission. This is a shared integration issue, not an additional email-only requirement.

All mailbox, thread, attachment, cursor, and subscription operations recheck tenant scope. SSE reconnects and long-lived subscriptions must respect token expiry/revocation. Invalid mixed-org mailbox lists must never return partial unauthorized results.

UI distinguishes pending agent processing, queued outbound, accepted by provider, delivered, bounced, blocked, and uncertain delivery. Provider acceptance is not proof of delivery.

## Provider, domain provisioning, and MVP limits

Resend with conservative sending limits is the current proposal; provider choice is not finalized. It would handle both inbound and outbound transport, with the Email Gateway owning registration of org domains, stable mailbox names, threading, retention, and processing state. No platform-side Resend code is required. Configure the dedicated mail root and do not derive identity from a renameable deployment hostname.

Proposed initial limits from discussion: 10 recipient deliveries/mailbox/rolling 24 hours, 25/org/rolling 24 hours across agents, and 250 across the pilot. These numbers were proposed by the assistant and are not confirmed requirements. Count every To/Cc/Bcc delivery, including automatic replies; enforce reservations atomically within the gateway and avoid double-counting retries of one send intent. At the cap, expose a blocked state. Suppress hard-bounced recipients and propose pausing an org after its first complaint. Also bound inbound-triggered runs and queued work.

Consider a dedicated Resend team for this service, especially if the existing account sends platform login/billing messages. Separate keys, billing, and usage are documented; complete isolation from provider enforcement is not assumed. Resend's account-wide reputation/suspension risk remains accepted only if the MVP decision explicitly accepts it. Agent-initiated correspondence must fit Resend's acceptable-use policy; a small quota does not make unsolicited outreach permissible. [Teams](https://resend.com/docs/dashboard/settings/team), [tenant tradeoffs](https://resend.com/docs/knowledge-base/setting-up-resend-for-multi-tenants), [acceptable use](https://resend.com/legal/acceptable-use)

Resend send idempotency lasts 24 hours, so gateway intent records must outlive that retry window. Resend documents 30-day email-data retention on standard plans: preserve any required content/attachments in service-owned storage before provider expiry, or explicitly limit the product's retention. A webhook receipt is not a complete content archive. [Idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [retention and quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)

The broader [provider research](SUP-877-email-provider-research.md) covers AgentMail/Nylas hosted mailboxes, CloudMailin inbound plus SES outbound, and other options. Cloudflare Email Routing was ruled out for the earlier workspace-subdomain design because of its documented domain limit. Do not infer wildcard Resend domain registration from a wildcard MX record; confirm its API and plan behavior.

### SES/Lambda alternative, entirely inside the gateway

If SES is selected, use one SES tenant per organization with explicit tenant suppression and sending-identity/configuration-set association. Shared infrastructure/account risks still exist. A shared receiving rule can match tenant subdomains; raw MIME stays in S3. Its S3-action notification can flow SNS → SQS → Lambda, and Lambda commits normalized mail into the **Email Gateway's database**, never platform's database. The gateway's independent CF API reads those records. This preserves the previously discussed ingestion/API separation without platform ownership. [SES tenant suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level.html), [SES receipt](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html)

## Gateway ingestion, publication, and notifications

- Provider webhooks/events are authenticated independently of platform user credentials. Resolve destinations through the gateway mailbox registry and derive tenant ownership from it; sender-supplied org IDs are not authoritative.
- Persist verified ingress before acknowledging delivery. Jobs fetch/parse or retrieve provider-parsed content as appropriate. Complete required object writes before publishing a ready mailbox record. Reject or hold malformed/oversized input durably; retry temporary failures with an observable dead-letter/replay path.
- Atomically persist normalized message state, thread association, attachment references, disposition, and durable mailbox event. A database uniqueness constraint covers provider/account/message ID plus destination mailbox. Retrying after a committed write with a lost response returns the existing result.
- Receipt is separate from permission to execute. Held, blocked, automated, or malformed mail must not appear as executable work. The gateway rechecks current mailbox policy on claims; the app rechecks its current agent ACLs before execution.
- Poll/replay of committed events is authoritative. Notifications are wakeup hints; losing one cannot lose mail. Cursor/claim semantics must not skip late-committing events. Subscriptions and attachments use the gateway's identity and ownership checks. Clients never subscribe directly to its database.
- Original message and attachment storage remains private and service-owned. The gateway proxies authorized attachment downloads or issues time-limited signed URLs, with the revocation limitation of those URLs stated explicitly. No platform storage service is required.
- Sending/replying persists a gateway-owned intent before provider submission, with stable retry identifiers and uncertain outcomes surfaced. Bounce, complaint, suppression, and delivery events update the same service-owned records idempotently, including when feedback arrives before the send response is recorded.
- Mailbox persistence/claim handling is in this feature. SUP-912 still owns the separate application-to-agent durable acceptance and uncertain runtime handoff work.

## Remaining decisions

1. Domain allowlist matching: proposed exact domains with subdomains explicitly listed, restricting both inbound and outbound for internal-only behavior.
2. All platform-connected installations or hosted cloud only? Proposed: all, with offline backlog and one assigned consumer.
3. Exact mail root and stable org-domain allocation, including Resend per-subdomain provisioning and domain capacity if that MVP option is selected.
4. Recipient behavior: proposed sender-only automatic replies and explicit reply-all; confirm To/Cc/Bcc support.
5. Protected sender authentication standard and non-auth-mode identity rules.
6. Numeric message/attachment sizes, recipient limits, outbound quotas, incoming-run budget, backlog cap, and retention periods. These must be set before launch; indefinite retention is not implied.
7. Prompt-injection filtering implementation, review surface, and failure behavior; clarify whether open inbound gets any additional execution restrictions.
8. Finalize Resend MVP versus alternatives and accepted tenant risk; the standalone service boundary is fixed regardless.
9. General platform identity endpoint, supported principal/enrollment contract, revocation/cache bound, and subscription revalidation interval. Online introspection is the proposed MVP; audience-bound short-lived JWTs are an alternative.
10. Gateway repository/deployment, independent database/storage choice, and provider content retention strategy.

## Acceptance scenarios

- Concurrent setup requests cannot claim the same address; retry after partial failure recovers it. Agent/workspace renames preserve the address.
- New messages create threads; valid replies resume the right session after restart. Proactive outbound mail gets a resumable conversation. Same subject and forged references do not merge or authorize threads.
- Every permission mode is exercised inbound and outbound, including removed users, viewer-only users, forged From, changed Reply-To, new Cc participants, and policy changes during a run.
- Email Gateway receipt survives offline consumers, reconnect, duplicate notifications, and subscription loss. Two installations cannot both claim mailbox work. App crash recovery is tested separately in SUP-912.
- Email send retries reuse their stable intent; ambiguous provider sends appear as uncertain. Common run-submission recovery belongs to SUP-912 and is not claimed as delivered by SUP-877.
- Cross-org mailbox IDs, thread IDs, attachments, cursors, subscriptions, and revoked credentials are denied.
- Sends use the intended org/provider domain configuration; bounce, complaint, suppression, and quota events prevent further disallowed sends. If SES is selected, verify the explicit tenant settings.
- Gateway ingestion retries after database outages, partial attachment retrieval/storage, and commit-with-lost-response publish one message/event per destination mailbox. Polling recovers lost notifications; concurrent commits cannot cause skipped events.
- The service deploys and operates without platform database access or a platform email adapter. Invalid/revoked credentials and forged org/member/installation context cannot access mailboxes. Platform identity outages preserve inbound receipt while protected operations follow the documented failure behavior.
- MIME parsing, filename/path handling, attachment limits, HTML-to-text conversion, quoted-content handling, and automatic-reply loops are tested with real email fixtures.
- End-to-end delivery through common email clients proves actual Message-ID/References round trips, recipient behavior, attachments, and no streamed/tool-output leakage.
