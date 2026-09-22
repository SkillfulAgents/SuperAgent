# Durable integration delivery

`IntegrationDeliveryQueue` owns locally accepted input delivery for every
`AgentIntegration`. Slack, Telegram, iMessage, Linear, and future families use the
same manager, store, scheduling, deduplication, and lifecycle rules. Providers
supply stable event IDs, routing, context preparation, and output delivery.

This is a handoff queue, not a turn lock. Once the runtime accepts one input,
another input can enter that same session immediately through the runtime's
existing queue/steering behavior. An earlier message in retry backoff does not
block a newer follow-up. Host failure notices have a separate scheduling lane.

## Acceptance and dispatch

The manager resolves the provider's route and inserts the event and route before
its `onEvent` handler resolves. The unique key is `(integrationId, externalId,
eventId)`, where `externalId` is the logical session key. Payloads must be JSON
serializable; families validate and decode their payloads, including dates, on use.
The generic envelope is validated with Zod both when written and when recovered.
The optional `acknowledgeInput` hook runs only after a newly accepted event is
stored; duplicate events do not repeat acknowledgements. This does not change a
provider transport's own network ACK/replay guarantees or fetch missed remote events.

The store uses a conditional insert and compare-and-set transitions. Each attempt
gets an owner token; lifecycle cancellation clears that token, preventing late
completion from reviving a cancelled record. Before retrying a mapped input, the
manager checks the same session is still mapped. Normal access, attribution,
configuration, and provider policy checks still run at dispatch.

A new session is created idle, registered, mapped, and attached before its first
input is sent. Immediately before runtime handoff the row becomes `sending` and
records the session ID. The delivery's UUID is passed as the runtime message UUID.
Successful acceptance becomes `delivered`; agent turn completion is not involved.
Free-text answers consumed by a family's existing question handler use the same
write-ahead handoff boundary.

## Retries and uncertain outcomes

Preparation/dispatch failures retry up to **five attempts**, with delays of
**1 second, 5 seconds, 30 seconds, and 2 minutes**. Invalid input and explicit
permanent errors stop immediately. A definite pre-acceptance runtime refusal
(container not running or session not found) can retry; a missing session retains
the existing self-heal behavior. A session-creation failure has not sent any input.

On startup, interrupted preparation returns to the pending queue. A row left in
`sending` is reconciled by searching the host transcript for its runtime UUID.
Finding that user entry proves acceptance. Missing evidence, a failed transcript
read, a timeout, or a lost send response **does not prove rejection**: the message
may be queued in the runtime or already executing. Such a row settles as
`uncertain`, is never automatically resent, and produces a notice asking the user
to check the conversation before retrying. A successfully acknowledged runtime
handoff is not replayed after a host restart.

This provides durable local acceptance and bounded handoff retries, not exactly-once
agent/tool execution or a durable replacement for the runtime's own message queue.
A cold empty session left by a failed setup can be replaced without duplicating work.

## Failure notices and lifecycle

Exhausted/permanent dispatch failures and uncertain handoffs create a pending host
notice in the same record. The notice uses the original stored reply destination,
including the original Linear comment thread after reconnect. Notice attempts have
an independent five-attempt budget and the same backoff. Exhaustion is a terminal
`failed` notice state and is reported once; it does not block later input. Providers
must propagate delivery failures to the manager. A provider that accepted a notice
but lost its response may receive a duplicate notice on retry; this never reruns
agent work.

Explicit pause (including auto-pause), authorization loss, installation removal or
replacement, external cancellation, access revocation, and session reset cancel
pending delivery and notices. Resume does not resurrect that cancelled work. Normal
transport reconnect preserves pending work. Shutdown preserves accepted records for
startup recovery. Installation/agent deletion cascades records; factory reset also
explicitly clears the table. Already handed-off work remains governed by the
runtime's existing interrupt behavior.

Terminal records retain IDs/outcomes for **seven days** for deduplication and
diagnostics. Payloads are erased as soon as delivery settles, or after its failure
notice settles. Cleanup runs on startup and at most hourly during queue activity;
unsettled work is retained. Retry timers query only the local database. There is
no provider polling, history catch-up, or new background container subscription.

Interactive button decisions continue through the existing request registry and
claim semantics; they are not blindly replayed as new message turns.
