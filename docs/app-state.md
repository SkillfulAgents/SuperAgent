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

## Helpers: owned leases

**`defineLease({ name, ttlMs, renewEveryMs? })`** (`lease.ts`) lets at most one owner hold a key at a time. The lease ends when the owner releases it, or when `ttlMs` passes without a renewal. Every acquisition is a new owner with a random id. The revision of the owner's last write is its fence.

A holder judges how long it has the lease by its own clock alone:

- It reads `Date.now()` before it sends an acquire or a renewal. The backend can only have written the lease after that, so the lease is held at least until `sent + ttlMs`. That is the held lease's `heldUntil`.
- An answer that arrives at or after `heldUntil` counts as not held, however the backend answered. A late acquire returns null, and a late renewal counts as lost. In both cases the write is released if it is still there, so it does not block the next owner.
- The backend's own expiry is never compared with this process's clock, so clock skew between the two plays no part.

The operations:

- `acquire(key)` is one `insertIfAbsent`. It returns the held lease, or null while another owner holds the key.
- `renew(lease)` is a `compareAndSet` against the held revision, with a fresh `ttlMs`. Once the lease has lapsed its revision never matches again, so renewal returns null even after another owner has taken the key.
- `release(lease)` is `consume({ revision })`. A stale owner's release does nothing to a successor's lease.
- `hold(lease, work)` runs `work` while the lease is held:
  - It renews every `renewEveryMs` (by default a third of `ttlMs`), one renewal at a time.
  - It aborts `holding.signal` with `LeaseLostError` when a renewal finds the lease gone, is answered too late, or cannot reach AppState. It also aborts at `heldUntil` if no renewal has landed by then, so a renewal that never answers still ends the holding.
  - It releases the lease when the work settles.
- `holding.confirm({ minRemainingMs })` renews at once. It resolves only if the renewal is answered in time and the lease is then held for at least `minRemainingMs` more (default 0). Otherwise it aborts the signal, releases the lease and throws `LeaseLostError`.
  - Call it right before a request or a write only the holder may make, with nothing awaited in between.
  - Before a request, pass the request's timeout, so the request cannot outlive the lease even if no later renewal lands. Before a write, pass a margin for the write.
- `acquireWhenFree(key, { timeoutMs, whileWaiting })` waits while another owner holds the key. It tries again at 50 ms, doubling up to 1 s, and throws `LeaseWaitTimeoutError` after `timeoutMs`. A `whileWaiting` result other than undefined ends the wait without the lease, for when the work was done elsewhere: a waiter re-reading the row its holder writes, for example.

A lease fences AppState writes, and nothing else:

- A request the holder has already sent keeps running after its lease lapses.
- A write elsewhere, to the database or a provider, needs its own condition.

So pick a TTL longer than the longest request plus the time one renewal takes. Confirm with the request's timeout before sending, confirm with a margin before writing, and keep the write conditional too. If a holder that lost its lease may leave an unknown side effect behind, such as a rotated token, record that next to the lease. Use a key that outlives the lease, so the next holder can see it.

The GitHub and Linear clients use it, each with a 30 s lease:

- GitHub installation-token minting uses `claim:github-token`. It confirms with the 20 s request timeout before minting. Each process still mints and caches its own token. The claim only keeps two processes from minting at the same time.
- Linear's rotating-token refresh uses `claim:linear-token-refresh`. It confirms with the 15 s exchange timeout before sending, and with 5 s before saving or revoking. Unresolved exchanges are recorded in `linear:unresolved-exchange`.

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

Hangup retries (1 s, 5 s, 30 s), removal retries and the deadline hangup run on one `voice.hangup` wakeup per session, on the TaskManager of the process that created the session, or that was asked to close it. The local manager keeps that wakeup in memory, so if that process goes away, its sessions stop counting at their deadlines and nobody hangs them up. A durable owner that recovers provider cleanup is a follow-up, on a backend that survives the process.

## LLM device sign-in

A subscription provider's device sign-in (Grok, Codex, Kimi, MiniMax) can be started, polled, saved and cancelled by any process that serves the tenant (`src/shared/lib/llm-provider/oauth-login.ts`). The ticket's `oauth:llm:{loginId}` is the strong namespace `oauth:llm` with key part `loginId`: one record per sign-in.

- The record holds the provider's device data, what polling that provider needs (Grok's token and userinfo endpoints, the Kimi or MiniMax region, MiniMax's PKCE verifier), the user who started it, the connection's owner and id, the provider's device expiry, the poll schedule (interval, next poll allowed, the `slow_down` backoff) and a status: `pending`, `completed` with the credential, `saving`, or `failed` with the provider's message. It holds no functions: the process that polls rebuilds the provider call from it.
- Every write passes the device expiry as `{ at }`, so neither a poll nor the credential extends it. The record expires then, and so does the credential a sign-in completed but nobody saved.
- Only the user who started a sign-in may poll, save or cancel it, and a global connection's sign-in also takes an admin. Anyone else gets the same answer as for a sign-in that expired.
- Secret-bearing fields are stored as they are for now; sealing them through KeyManager is a separate change.

**The limit.** The tenant may have 100 sign-ins pending at once, as before. One strong record (`oauth:llm:pending`) lists them, changed only through `reduceRecord`. A start reserves a place for 60 s before it asks the provider for a device code, then the place counts until the device expiry. A save or a cancel frees it; a sign-in the provider failed keeps it until its expiry, as every started sign-in did before. A place whose process went away stops counting at its `expiresAt`, so the limit heals by itself.

**Polling.** A poll that is due takes the lease `claim:llm-oauth-poll` for the sign-in (60 s). A poll that finds it taken answers `pending`; the holder writes what it hears.

- The holder reads the record again once it holds the lease, and decides from that.
- It confirms the lease with 45 s, the longest provider poll (Codex's two 20 s requests), right before asking, so no other process asks the provider while it waits.
- It writes the answer with a compare-and-set against the record it decided from. If its lease is lost by then, it writes only a credential, and only over that same record; a pending answer or a failure is dropped, since another holder may be asking now.
- A provider's own failure (declined, expired) is written as `failed`, and later polls in any process report it without asking again. Any other error (network, parse) is written as a generic failure, since its message may say more than it should.

**Saving.** The connection save reads the completed sign-in, then claims it right before its database write: a compare-and-set from that read to `saving`. Of two saves only one claims it, and a save after a cancel or the expiry is refused. A failed database write hands the credential back (`completed`), so a corrected save can use it. After the write the sign-in is removed (`consume` against the claim). A removal whose answer was lost is tried again; one that never lands leaves the sign-in `saving`, which no save takes again.

**Cancelling.** `DELETE /api/llm-connections/oauth/:id` removes a sign-in that is not `saving` and frees its place. A poll's answer that arrives afterwards is dropped. The settings screen does not call it yet.

**Lost answers.** Each write carries a fresh `writeId`. When a compare-and-set's answer is lost, the writer reads the record back: its own `writeId` means the write landed, the revision it decided from means it did not and it tries again, anything else means the sign-in moved on. A start whose writes cannot land removes what it may have written and frees its place.
## Browser Vault handoffs

What the user typed for a later sign-in step, and the username the last step went in with (`src/shared/lib/browser-vault/held-values.ts`; [docs/browser-vault.md](browser-vault.md#steps) has the flow). The ticket's `vault:held:{agentSlug}:{sessionId}:H(site)` and `vault:identity:{agentSlug}:{sessionId}:H(site)` are the strong namespaces `vault:held` and `vault:identity`, with key parts agent slug, session id and `digestKeyPart(site)`.

- A held record lists its parts (`password`, `text:<label>`), each with its value, its own id and, while a fill has it, a claim (`{ id, until }`). It also holds the username, the origin the values were typed on and the "Save for later" owner. The values are stored as typed for now; sealing them through KeyManager is a follow-up. They never go into a key, an event or a log.
- A hold replaces the record and sets 30 minutes (`expiry: 'reset'`). Every other write keeps that deadline (`keep`), so using some parts does not renew the rest. With `carry`, a hold brings along the parts of an earlier read that are still there under the same id; a part used or forgotten since is not brought back.
- Every change other than forgetting goes through `reduceRecord` and names the part ids it was decided from, so a part held again since is never claimed or released by mistake, and concurrent changes to different parts all land.
- A fill claims the parts it sends before sending them: all of them, or none. Claimed parts are not offered to anyone else. Its settle drops the parts that went in (or may have) and frees the others while the claim stands. A claim's answer that was lost is retried under the same claim id, which recognises its own claim. A claim that cannot be confirmed is handed back, and the error is thrown, so nothing is filled.
- A claim not settled within five minutes (its process went away, or AppState was down for all of its tries) is abandoned: its parts are dropped by the next write and never offered again, since the fill may have gone in. Its own settle after the deadline drops them too.
- Forgetting (the user declined, or signed in by hand) deletes the record, claimed parts included.
- The identity is a plain `set` with `reset`: 30 minutes from the latest remember, and the latest remember wins.

Who may use what (the agent's grants, the page's origin, whether a saved account is still theirs) is decided by the callers at the host boundary, in `login-host.ts` and the sign-in routes. AppState only scopes the records; a read for a named account returns nothing held for another.
## MCP OAuth pending flows

A remote MCP sign-in is stored from its start until its callback is answered (`src/shared/lib/mcp/oauth-pending-flows.ts`), so the callback can reach any process. The ticket's `oauth:mcp:H(state)` is the strong namespace `oauth:mcp`, with the key part `digestKeyPart(state)`. The record is created with `insertIfAbsent`. It expires 15 minutes after creation (`keep`), and it moves through three states:

- `pending` holds the descriptor: the issuer check, the desktop delivery context, the token request's parts (PKCE verifier and client secret included, stored plainly until sealing lands), and where the credentials go. That is the server being re-authorized, or the new server with the user who started the flow. The descriptor holds no clients or closures. The process that answers the callback rebuilds the request from it.
- `claimed` means one callback is exchanging the code. The claim is a compare-and-set from `pending`, so of any number of callbacks on any processes, one gets it. The claim keeps the issuer check and delivery context but drops the secrets. It sets the record to expire 60 s later. A holder that dies therefore ends the flow at that point, and does not hold it for the rest of the 15 minutes. Until then, a duplicate callback is told the sign-in is already being completed. After that, it is told the sign-in has expired or was already used.
- `finished` is a tombstone with no secrets. It is kept 15 minutes from the finish, so a late duplicate is told the link was already used.

A callback is checked against the stored record, its state and then its issuer, before anything is written. A callback with the wrong issuer changes nothing, so the legitimate callback still completes.

Around the token exchange:

- The exchange runs only inside the claim. The claim is held for 60 s by the holder's own clock, counted from when the claim was sent. The exchange is cut off after 30 s, which leaves 10 s for the finishing write. If the claim is answered too late for that, it is given back unspent to `pending`, at the flow's original expiry, and this callback fails with "try again".
- Once the code has gone to the provider, the flow is finished whatever the answer. An authorization code is single-use, and a provider may already have spent a code whose answer was lost. RFC 6749 §4.1.2 also lets a provider revoke the tokens of a code presented twice. Releasing the flow would only let the same code be sent again. Starting the connection again gets a fresh state, verifier and code.
- The finishing write is a compare-and-set against the claim. Only the claim's holder writes a claimed record, so the write fails only when the claim lapsed first, as with a machine asleep mid-exchange. The holder then drops the tokens rather than overwrite whatever the user did since.
- The credentials are written to the `remote_mcp_servers` row only after the finish lands.
- A lost answer to the claim or the finish is settled by reading the record back. The claim's owner id is random per callback, so the holder can tell its own write from anyone else's.

An authorization error response (`?error=…`) with a valid issuer ends a `pending` flow. It leaves a claimed or finished one alone. Nothing is published: the callback page carries the result to the client, and the route does its own follow-up after the database write. Logs name the step that failed, never the state, the code, the verifier, the client secret or a token. A failed write is logged by its driver cause, because drizzle's own message quotes the statement's parameters.
## Chunked uploads

A large file arrives in chunks, which can reach different processes (`src/shared/lib/utils/chunked-upload.ts`). AppState decides everything and a byte store only keeps bytes. Desktop and web use this machine's disk, the only store that ships. `UploadByteStore` is the port for another: a deployment that adds one passes it to `setUploadByteStore` at boot, and needs a shared AppState too, since every process that takes a chunk must see the same manifest. The ticket's `upload:{ownerId}:{uploadId}` is the strong namespace `upload`, with key parts `digestKeyPart(ownerId)` and the upload id. The bytes sit under the same two parts, so two owners using one upload id share nothing.

**An upload is one attempt: its chunks in order, one write at a time.** That is how the client sends them. A failed upload is not resumed: the user sends the file again, under a new upload id. That is the accepted cost. Resumable uploads are separate work that would need its own reason.

A manifest moves one way through three states:

- `receiving` binds the target, the chunk count and the size limit, and lists the committed chunks in order and the one attempt writing now.
- `finalizing` has every chunk, and one request is running `finish`.
- `ended` holds nothing. The upload succeeded or failed, and later chunks are refused until it expires.

**Storing a chunk.**

1. **Reserve.** A compare-and-set takes the write slot, for exactly the next chunk. Chunk 0 creates the manifest. Anything else is refused with 409 and changes nothing: a gap, a duplicate, an overlap with a write in flight, chunk N with no manifest, chunk 0 on an existing manifest, or a chunk that disagrees on the target, count or limit. A chunk that takes the upload over its limit gets 413, ends the attempt and removes its bytes.
2. **Write.** The bytes go under a key no other attempt uses (`uploads/{owner}/{uploadId}/{startedAtMs}-{uuid}`), so a late write can touch nothing but its own bytes.
3. **Commit.** A compare-and-set adds the chunk and frees the slot, only while this attempt still holds it. A write that finds otherwise is refused and removes its bytes. It never creates a manifest.

**The claim.** The commit of the last chunk moves the upload to `finalizing` in the same compare-and-set, and that request runs `finish`. Nobody else ever does: a request that finds `finalizing` or `ended` gets 409. Nothing lists bytes to decide completion.

**`finish`** gets the upload's `size`, a `stream()` and a `toFile()`, and the upload ends with it, whatever happens.

- `stream()` reads the committed chunks in order through the byte store, opening each only when the one before it has been read through. It closes only after the last chunk proved the size in the manifest. A chunk that is missing, unreadable, shorter or longer errors it, so a consumer cannot take part of an upload for the whole.
- `toFile()` writes that stream to a file under `assembled/`, for a consumer that needs a path, and the file is removed after `finish`. Nothing is written unless someone asks.
- The workspace route streams into `FileOps.write`, which leaves nothing behind when its stream errors. Template import asks for a file, because a ZIP reader seeks.

**Any failure ends the attempt.** A failed write, a failed read or a `finish` that throws moves the upload to `ended` and removes its bytes. Nothing is retried, and no answer is kept. A compare-and-set whose answer is lost fails the request with no retry and no read-back: it may have landed, even as the claim, and a request that does not know it won does not run `finish`. It ends the attempt if it can.

**An unknown outcome.** A request that finds `finalizing` or `ended` is told to check the result before starting a new upload, because that upload may have succeeded. `finish` throws `UploadOutcomeUnknownError` when its side effect may have happened and something after it failed, as an import does once the agent exists, and the error says so. A crash during `finish` leaves `finalizing` until the manifest expires, and nobody takes over. **A new attempt after an uncertain result may repeat an import that already succeeded.** That is accepted rather than recovered.

**Expiry.** A manifest expires an hour after its last write (`reset`), judged by the backend. That is also the deadline of the write slot, so no process compares clocks: a writer that stalls holds the slot until then, and every other chunk is refused, and a commit after it is refused. There is no lease and nothing renews the manifest while `finish` runs, so a `finish` that runs past the hour is not protected. Once the sweep has been, its stream errors on the next chunk it opens, and the request fails. A `finish` that outlives its manifest also brings nothing back, and an upload that started again under the same id is another upload it cannot touch.

**The sweep.** Expiry deletes no bytes, so `startStaleUploadCleanup` sweeps once when `afterBindInitialize` runs and then every 30 minutes, and removes bytes older than an hour that no manifest refers to. Importing the routes starts no timers, and the perf harness runs no sweep, as it skips that startup.

- A chunk, or the attempt in the write slot, stays at any age while its manifest is live.
- Bytes the manifest does not name stay dead whatever happens after the read, since a commit needs the slot and an attempt takes it before it writes.
- Age comes from the key, by the writer's clock, because another store's listing need not give one. It only decides when unreferenced bytes go, so no clock can cost a live upload its bytes.
- Files `toFile` wrote that are older than an hour go too, unless the upload is `finalizing`. So does anything left in the layout from before manifests, by age alone.

With `LocalAppState` the manifests live in memory, so a restart forgets uploads in progress, and their bytes are swept later. A client that goes on sending gets 409 for its next chunk and sends the file again.
## Team directory listings

Each connected team directory's people (`src/shared/lib/team-directory/cache.ts`; [docs/team-directory.md](team-directory.md#the-cache) has the rules). The eventual namespace `cache:team-directory` is keyed by directory id and credentials revision, so reconnecting starts afresh. It is a plain, non-atomic cache: an entry is `{ listedAt, attemptedAt, users }`, fresh for 10 minutes and kept 6 hours after its last write. A stale entry is answered at once while a new listing runs in the background, and a failed listing keeps the previous people and only moves `attemptedAt`, at the entry's own expiry. Two processes may list the same stale directory at once; the later write wins. The listing in progress is a Promise in a process-local map, so concurrent searches in one process share it.
