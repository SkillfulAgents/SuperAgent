# AppState

AppState holds the keyed state and live events that every process serving one tenant shares. Desktop and single-tenant web keep it in process memory (`LocalAppState`). A deployment that serves a tenant from many short-lived processes installs a remote implementation at its entry point. Application code is the same for both. The code is in `src/shared/lib/app-state/`; the contract is `contract.ts`.

Use it for state that has to outlive one request or reach another process: pending sign-in flows, rate-limit counters, claims, cache snapshots, and live hints. Do not use it for agent-owned state (that belongs to the Actor), durable records (the database), file bytes (a blob store), or work that must eventually run (its owner or a durable job). Process-local handles stay in the process too: functions, Promises, sockets, timers and client instances. Serialize the data they carry and keep the object local.

## Initialization

Each entry point awaits `initializeLocalAppState()` right after `openDatabase()`. The entry points are Electron main, `src/web/server.ts`, the Vite dev server's `server-lifecycle` plugin and `perf/harness.ts`. Importing the module selects no backend and does no I/O. Calling `appState()` before initialization throws. A second initialization is refused, so nothing swaps the tenant of a shared global between requests: each instance serves one `AppStateScope` (`{ deploymentId, tenantId }`) for the life of the process. A Cloudflare entry point passes its own implementation to `initializeAppState(...)`; consumers do not change.

Call `appState()` each time you use it. Do not keep the result in a module constant. The installed instance is held on `globalThis`, so another copy of the module sees it too: after a test's `vi.resetModules()`, or after Vite re-instantiates the module following an edit.

`closeAppState()` closes the instance and forgets it. If an initialization is still connecting, it is cancelled and awaited: the backend it connected is closed instead of installed, and that initialization rejects.

The shared test setup (`src/renderer/test/setup.ts`) installs a fresh `LocalAppState` before every node-environment test, so tests need no AppState setup of their own. A test of the uninitialized path calls `closeAppState()` first. `createLocalAppState({ scope, backend: new LocalAppStateBackend({ now }) })` gives a test its own clock, or several tenants over one backend.

## Namespaces and keys

```ts
const pendingFlows = defineNamespace({
  name: 'oauth:mcp',              // lowercase segments joined by ':'
  consistency: 'strong',
  schema: pendingFlowSchema,      // Zod, non-transforming
  expiry: { ttlMs: 10 * 60_000, onUpdate: 'keep' },
})
const key = pendingFlows.key(digestKeyPart(state))
```

- **Prefix.** Every key and channel is stored under `gamut:v1:{deploymentId}:tenant:{tenantId}:{path}`. A path is `{name}/{part}:{part}`, with each part URI-encoded. No name or encoded part can contain `/`, so:
  - `key('a:b')` and `key('a', 'b')` are different keys;
  - namespaces `pending` and `pending:oauth` never share a key, and the same holds for topics.
- **No secrets in keys.** Pass a token, email, IP or URL through `digestKeyPart()` (SHA-256, base64url). Agent, user and account IDs scope data; they never stand in for an authorization check.
- **Validation.** Every value is validated with the namespace schema when it is written and when it is read, then stored as JSON. A read returns a fresh copy, so changing it changes nothing stored. Schemas must not transform: a parsed value must parse to itself.
- **Consistency is declared per namespace.**
  - `strong` reads are authoritative, and these operations are atomic in the backend: `insertIfAbsent`, `compareAndSet`, `increment`/`decrement` (optional `min`/`max`) and `consume`.
  - `eventual` is for disposable caches only: `get`, `getMany`, `set` and `delete`, and every entry must expire. The types refuse the atomic operations on an eventual key, and a backend refuses them at runtime.

### Expiry

Expiry is the instant from which reads stop returning an entry, even if the backend has not removed it yet. It runs nothing: a cleanup that must happen needs its own owner.

- A namespace sets `ttlMs` for new entries (`null` means no expiry, and only a strong namespace may have none).
- Its `onUpdate` says what a write does to a live entry's expiry: `keep` the original (a fixed window or a deadline) or `reset` it (an idle lifetime).
- A single write can choose differently with `expiry`:
  - `'keep'` or `'reset'`
  - `'never'`
  - `{ ttlMs }`, an amount of time from now
  - `{ at }`, an absolute instant, for carrying an expiry decided earlier. The OIDC key-set cache uses it to expire a copy ten minutes after the original download.
- A missing key and an expired key are the same: absent.

### Revisions

Every write returns an opaque `revision`. `compareAndSet(key, expected, value)` writes only while the key still holds that write; `expected` is `null` to write only while the key is absent. `consume(key, { revision })` deletes only that write. A revision is never issued twice. A revision read before a key was deleted or expired never matches the key once it is written again. A conflict returns `{ ok: false, current }`, so the caller can retry from what is stored now. Retry from `current`; never retry blindly.

## PubSub

```ts
const roster = defineTopic({ name: 'events:meeting:roster', schema: z.object({ revision: z.string() }) })
await appState().publish(roster.channel(meetingId), { revision })
const subscription = await appState().subscribe([roster.channel(meetingId)], onChange, { signal })
```

- `publish` resolves once the backend has accepted the event. It does not wait for listeners or their work.
- Listeners get their own validated copy of the event, and the channel object they subscribed with.
- Nothing is retained. A subscriber that was not connected, or that reconnects after a gap, re-reads the authoritative state; it does not wait for a replay. Event payloads carry IDs, statuses and revisions, never credentials.
- Do not depend on order between events: no order is promised across backends. `LocalAppState` happens to deliver in publish order.
- After `unsubscribe()` resolves, the listener is not called again. The same goes for an aborted `signal`, including one that aborts while `subscribe` is still setting up, and for `close()` of the instance.
- PubSub is not a job queue. Work that must happen goes to its owner directly; a hint only says "look again".

## Implementing a backend

A backend implements `AppState` from `contract.ts` and runs the shared suite:

```ts
describeAppStateConformance('CloudflareAppState', () => ({ open, advance, settled }))
```

`open(scope)` returns a client. Two clients of one scope share state, as two processes do. `advance(ms)` moves the backend clock, and `settled()` resolves once everything published so far has been delivered or dropped. The suite covers:

- competing inserts, compare-and-sets and consumes across two clients
- lost increments
- the counter bounds
- expiry at the boundary
- `keep` vs `reset`
- stale revisions after deletion or expiry and recreation
- copied values and schema rejection
- tenant isolation for both state and events
- unsubscribe, abort and close

What a backend must preserve beyond the suite:

- Strong namespaces are read from and written to the authority (a tenant Durable Object, or Redis), and their records survive eviction. An eventual namespace may be served from a store with propagation delay, never past its expiry.
- Revisions stay unique across deletion, expiry, eviction and restart. Do not derive them from a per-key counter that restarts at 1.
- Use the shared encoders in `definitions.ts` (`scopePrefix`, `encodeValue`, `decodeValue`, `resolveExpiry`, `assertStrong`) so keys, validation and expiry behave identically everywhere.
- Subscriptions must be rebuilt from serialized routing when a Durable Object is woken from hibernation. They must not rely on a JavaScript callback surviving eviction.
- Secrets in a shared backend are sealed through KeyManager (SUP-1509). AppState never holds a raw root key.

## The global feed

`globalFeed` (`src/shared/lib/notifications/global-feed.ts`) carries the app's live hints to clients through three topics. It picks an event's channel from its top-level `recipientUserId` and `agentSlug`:

- `events:feed:user`, one channel per user: an event with a `recipientUserId` (a mention, its withdrawal), and what `publishToUsers` addresses (membership changes, a new agent to its members).
- `events:feed:agent`, one channel per agent: any other event that names an agent (status, sessions, requests, schedules, triggers, dashboards, widgets, shared notifications).
- `events:feed:tenant`, one channel: everything else (runtime readiness, alerts, the webhook relay, drives, platform notifications).

Local mode has one principal and no access lists, so every event goes on the tenant channel there.

The notifications SSE route (`src/api/lib/notifications-feed.ts`) follows the tenant's channel, its user's channel and the channel of each agent the user can access. It reloads that set on a membership hint, on a new agent announced on the user's channel, and every minute, and it still checks every event against the loaded set. A revocation is sent on the removed user's own channel, so it reaches them after they stop following the agent. Each stream holds at most 1,000 frames or 1 MiB for a slow client; past that the stream ends and the client reconnects and refetches.

`publish` returns before any listener runs. Work that must happen because of an actor's event is not a feed listener: the host starts it directly in `host/local-host-port.ts` (the after-run widget sweep, the chat card for an agent-scoped review).

## Helpers: fixed windows and lockouts

Typed helpers over the strong operations, for limits that several consumers share. Each one defines and owns its namespace.

- **`defineFixedWindow({ name, limit, windowMs })`** (`fixed-window.ts`): at most `limit` hits per key in a window that opens at the key's first hit and closes `windowMs` later. `hit(key)` is one bounded `increment` on a `keep` namespace, so a refused hit is not counted, and no hit moves the window's end: a burst late in a window does not extend it. It resolves to `{ admitted, count, remaining, resetAt }`. The auth and LLM rate limits use it.
- **`defineLockout({ name })`** (`lockout.ts`): failures per key, with no expiry, until a success clears them. `failed(key, policy)` counts one failure, and the failure that reaches `policy.threshold` locks the key for `policy.lockMs`, as does each one after it. `check(key, policy)` says whether the key is locked, and clears a lock that has run out. `succeeded(key, status)` clears the failures that the unlocked `check` saw, and keeps any failure counted since. Every write is conditional on the revision it was decided from, and a conflict is decided again from the current record. The account lockout uses it.

## Helper: reducing one record

- **`reduceRecord(key, reduce)`** (`reduce-record.ts`): the compare-and-set loop for a strong record that several writers change. `reduce` gets the stored value (null when absent) and returns `{ result }` to write nothing, `{ result, value, expiry? }` to write `value`, or `{ result, value: null }` to delete the record. The write is conditional on the revision the decision was made from. After a conflict, `reduce` decides again from the `current` the conflict returned, up to 64 times, then it throws. `reduce` can run more than once, so it must have no side effects: act on the result once `reduceRecord` resolves.

## Voice session admission

A user may hold four Live voice sessions at once, counting the ones a provider is still creating (`src/shared/lib/voice/live-session-admission.ts`). The ticket's `voice:owner:{userId}:sessions` is the strong namespace `voice:owner:sessions` with key part `userId`: one record per user, listing that user's sessions. Each transition goes through `reduceRecord`, so two processes cannot both admit a fifth session, and a late write cannot undo a newer one.

- An entry has the reservation's id (the handle the client gets), a state, the creating provider's id, the provider's session id once it exists, and `expiresAt`. It holds no key: a hangup uses that provider's key as configured at the time.
- `pending` counts until its two-minute lease runs out; the process creating the session renews it while the provider works. A start that fails, or whose request is cancelled, frees it at once.
- `pending` becomes `active` only while that reservation is still pending and within its lease. Otherwise the session just created is hung up and nothing is recorded.
- `active` counts until its deadline, an hour after creation. A release marks it `closing`, which stops counting, and the entry is removed once the hangup succeeds.
- Removal takes only that entry, and only once it was created (`active` or `closing`), never a `pending` one. It accepts `active` for an activation whose answer was lost: the session is hung up, and its entry may still count. A removal that AppState refuses is retried until it works or the deadline passes.
- Entries are kept five minutes past `expiresAt`, then dropped by the next write; the record expires with its last entry. The deadline hangup checks the record first, and skips a session another process has already hung up and removed. It skips only while the entry would still be kept: a timer delayed past that (a machine asleep) cannot tell, so it hangs up.

Hangup retries (1 s, 5 s, 30 s), removal retries and the deadline hangup run on timers in the process that created the session, or that was asked to close it. If that process goes away, its sessions stop counting at their deadlines and nobody hangs them up. A durable owner that recovers provider cleanup is a follow-up.
