# Cloud Workspace: the host app connecting to a remote deployment

This documents the "Cloud Workspace" feature — the desktop host app discovering
an organization's **remote, cloud-hosted Superagent deployment** and maintaining
an authentication token for it. It is easy to get lost here because the app talks
to *another instance of itself* running elsewhere, and the platform is split
across more than one host. Read this before touching anything under
`src/shared/lib/platform-auth/cloud-workspace-*` or `cloud-workspace-service.ts`.

## The mental model (read this first)

There are **three** independent parties, and the direction of the calls matters:

| Party | What it is | Role here |
| --- | --- | --- |
| **Host app** | *This* repo, running as the desktop **Electron** app | **Client** — discovers + connects to the cloud workspace |
| **Platform** | `gamutagents.com` (Gamut/Skillful) | Directory + token authority |
| **Cloud workspace** | An **auth-mode deployment** — *another running instance of this same codebase*, hosted for the org | The thing being connected **to** (it is the RFC 7523 receiver) |

The single most confusing point: **the "cloud workspace" is a full Superagent
deployment**, not a platform service. So the host app is, in effect, logging a
user into a *different copy of Superagent* that happens to live in the cloud. The
receiving `/api/auth/token/exchange` endpoint on that deployment is the host-side
token-exchange feature (see [Related](#related)).

The platform is **two hosts**, not one:

- **Auth issuer** — e.g. `auth.gamutagents.com`. Serves OIDC + the grant endpoint
  `POST /token/deployment-assertion`. Configured via `PLATFORM_AUTH_ISSUER_URL`.
- **Proxy** — e.g. the `/v1/*` API host. Serves discovery `GET /v1/me/deployments`.
  Configured via `PLATFORM_PROXY_URL`.
- (There is also `PLATFORM_BASE_URL`, the web/login origin — not used by this flow.)

Getting `PLATFORM_AUTH_ISSUER_URL` wrong (or pointing it at the proxy/base host)
is the classic failure: the proxy does **not** forward `/token/*`, so the grant
mint 404s.

## The flow

```
Desktop host app (Electron, CLIENT)      Platform                    Remote cloud workspace
                                                                     (auth-mode deployment =
                                                                      another instance of THIS app)
  │                                                                            │
  │ 1. GET {proxy}/v1/me/deployments ─────────────► proxy host                │
  │ ◄──── [{ org_id, deployment_url, authorization_server, status }]          │
  │                                                                            │
  │ 2. POST {authIssuer}/token/deployment-assertion ─► auth host (RFC 8693)   │
  │ ◄──── grant JWT  (aud = deployment, typ=deployment-assertion+jwt,         │
  │                   ~120s, single-use jti)                                   │
  │                                                                            │
  │ 3. POST {deployment_url}/api/auth/token/exchange ──────────► (RFC 7523) ──►│
  │ ◄──── deployment session token  (durable; PERSISTED, reused, refreshed) ──│
```

1. **Discover** the org's deployed workspace.
2. **Mint** a short-lived, single-use *grant* from the platform, scoped to that
   deployment.
3. **Exchange** the grant at the deployment's own endpoint for a **deployment
   session token** — the durable credential we keep.

The **grant** (step 2) is ephemeral plumbing. The **deployment session token**
(step 3) is the thing worth keeping — it is a real session on the remote
deployment. It is what [the cloud proxy](#the-cloud-proxy-desktop--deployment)
presents on every forwarded call.

## Token maintenance

`getCloudWorkspace()` (in `cloud-workspace-service.ts`) runs the whole cycle and
is deliberately **fully defensive — it never throws**; any failure degrades to
"no workspace". Rules:

- The deployment session token is **persisted** in settings (`cloudWorkspace`
  record) and **reused**. A fresh grant+exchange runs **only** when the stored
  token is missing, within **1 h of expiry**, or bound to a different
  `deploymentUrl`/`orgId`.
- **found / not-found is driven by discovery**, decoupled from token success — an
  older deployment without the exchange endpoint still shows as found; the token
  just isn't minted (`hasValidToken: false`).
- **Scoped to the acting org.** `/v1/me/deployments` answers for the *user*, who
  may belong to several orgs, so entries are filtered to the org the app is
  currently connected as. Another org's workspace would render an "Open" link
  this account can't use and a grant the platform would refuse.
- **"No workspace" and "couldn't check" are different answers.** A discovery
  that fails (unreachable, 401, malformed) returns `discoveryFailed: true`, and
  the card offers a retry. Only a *successful* discovery listing none shows the
  create-a-workspace CTA — otherwise an outage would invite the user to create a
  second workspace they already have.
- The record is **account-scoped**: it stores the `userId`/`memberId` **and a
  fingerprint of the platform credential** it was minted under, is only reused
  while all three still match, is cleared whenever the acting **org OR
  user/member** changes (`savePlatformAuth`) or on disconnect, and the account is
  re-checked immediately before the write so a refresh still in flight across an
  account change can't resurrect the old token. A same-user metadata refresh does
  not churn it.
- **One account snapshot per cycle.** `getCloudWorkspace` reads the bearer, the
  acting org, and the identity **together, once** (`readAccount`), presents that
  bearer, and re-checks the snapshot after every await — after discovery and
  after the exchange — before it clears, mints, or writes anything. Reading the
  token and the identity at different points across an await is exactly how
  account A's bearer ends up minting a session filed under account B, or how A's
  stale "no workspace" answer wipes B's valid record. If the account moved, the
  cycle is abandoned untouched and reports "unknown".
  The fingerprint is load-bearing, not belt-and-braces: `userId`/`memberId` can
  both be null on a connection whose introspection never filled them in, and on
  a *disconnected* app — so comparing only those makes two different accounts,
  or an account and no account, look identical. An unidentifiable principal is
  never equal to anything, including another unidentifiable one.
- Maintenance runs on boot, on connect, on Account-tab view, **and** on a
  low-frequency background poll in `PlatformService`, so a long-lived app stays
  valid without an Account visit.
- **Failures are reported once per process, from the service only.** Because
  maintenance re-runs every 30 minutes and the things that break it are usually
  persistent (offline, a token that isn't member-bound, a deployment too old to
  have the exchange endpoint), capturing every cycle would turn one broken
  install into a stream of identical Sentry events. The client never captures —
  it attaches the underlying error as `cause` on `CloudWorkspaceError` and
  throws; `reportFailureOnce` in the service dedupes by op + status. Don't add a
  `captureException` to the client.

## The cloud proxy (desktop → deployment)

`GET http://127.0.0.1:{port}/cloud/{key}/api/...` forwards to
`{deployment_url}/api/...` with the maintained token attached
(`api/routes/cloud-proxy.ts`). It is what lets the desktop UI drive the cloud
workspace: the renderer keeps calling loopback and only the prefix
`getApiBaseUrl()` returns changes.

**Why a proxy rather than pointing the renderer at the deployment.** Three
reasons, any one of which is fatal on its own:

- The packaged renderer loads from `file://`, so its requests carry
  `Origin: null` — a value an auth-mode deployment's origin allowlist cannot
  admit.
- Five renderer call sites cannot carry an `Authorization` header at all: two
  `EventSource` streams, `<img src>` (model icons, dashboard screenshots),
  `<iframe src>` (dashboards), and Electron's `downloadURL`. A token in the
  renderer would not reach any of them.
- It would need a deployment-side change, so a newer app could not drive an
  older workspace.

**Why the key is in the path, not a header.** Loopback is not a boundary a
browser respects: CORS is `*` in local mode, so any page the user visits can
already call the local API. That is survivable for a local install and is not
survivable for a channel into the org's deployment. The gate is therefore a
per-boot 256-bit secret — but it has to be reachable by the same five headerless
call sites above, so it rides in the URL prefix, where every call site picks it
up for free. It is regenerated each boot and never persisted, because a path
lands in logs. Loopback peer and a non-website `Origin` are checked on top.

Other properties worth not regressing:

- **Inbound `Authorization` is dropped, never relayed.** A caller cannot present
  its own credential to the deployment through us.
- **`set-cookie` / `set-auth-token` are stripped from responses** — those are
  credentials for the deployment's origin, and the whole point is that the token
  stays in the main process.
- **Redirects are followed here, not handed back.** A relative `Location`
  returned to the renderer would resolve against loopback and silently re-issue
  the call against the *local* API.
- **A 401 re-mints once and replays**, so a 24-hour deployment session does not
  surface as the app dying overnight. Bodies under 2 MiB are buffered to make
  that replay possible; larger uploads stream and forgo the retry. Whether a
  request *has* a body is read off the HTTP framing, not off `request.body` —
  the Node adapter hands every non-GET/HEAD request a stream whether or not
  bytes follow, so a bare `DELETE` would otherwise look unreplayable. That is
  only visible over a real listener, which is what
  `cloud-proxy.integration.test.ts` is for.
- **Only `/api` paths are forwarded**; anything else 404s, as does a bad key
  (a prober learns nothing either way).
- **Documents served through the proxy don't inherit its prefix.** A dashboard
  iframe is loaded from the keyed URL, but the HTML comes back unchanged, and a
  root-relative `/api/...` inside it resolves against the *loopback* origin. The
  LLM and speech shims injected into dashboards therefore derive their prefix
  from `location` at runtime (`api/polyfill-api-prefix.ts`) instead of
  hardcoding it — otherwise a cloud dashboard's LLM calls would silently run on
  the laptop's credentials and settings. Anything else injected into a proxied
  document has the same obligation.

**WebSocket upgrades are forwarded too**, by a second handler
(`main/cloud-stream-proxy.ts`) on the server's `upgrade` event. They have to be:
an upgrade leaves the request/response cycle and never reaches Hono, so the two
halves of one feature are necessarily two files. Without it the browser view —
the renderer's one WebSocket — is dead against a cloud workspace.

Two things it does differently from the sibling `browser-stream-proxy.ts`:

- **The upstream socket is opened before the client is upgraded.** A 401 on the
  handshake is the expected state every 24 hours, and once the browser has been
  told `101` the only thing left to say is a close code. In this order a re-mint
  is invisible — the browser is still waiting on its own handshake.
- **A relayed close code is clamped.** Codes below 3000 are reserved and cannot
  be sent by an application, so passing a `1006` straight through would throw
  inside the proxy rather than close the client.

It also declines any upgrade outside its prefix, so the local browser stream
keeps working exactly as before.

### How the renderer opts in

One question — local or cloud — is answered once, at boot, by the **main
process** (`main/api-target.ts`). `initApiBaseUrl()` asks for the answer
(`get-api-target`) and sets the returned URL as the base URL every call site
prefixes; that single value is what moves the whole UI.

- **The preference is main-owned, not renderer-owned**
  (`services/api-target-preference.ts`, stored in `settings.json`). The app has
  more than one renderer — the main window and the quick-dispatch launcher are
  separate `BrowserWindow`s — and they must never disagree about which machine
  executes work. Everything the decision rests on (the deployment token, the
  proxy key, the target itself) is already main-owned; the routing decision
  belongs with them.
- **The stored preference is an intent, not a promise.** It lives on a machine
  whose workspace may since have been disconnected, so it is only honoured if
  a cloud URL is actually available. Otherwise the app boots local with a
  recorded reason (`getTargetFallbackReason()`), rather than into a wall of
  failed requests against a workspace that is no longer the user's.
- **Availability is checked without a network round-trip** —
  `resolveCloudProxyTarget()` reads settings only, so boot does not wait on a
  discovery cycle that `PlatformService` already runs.
- **The renderer is told the finished URL, never the key.** Assembling the
  prefix renderer-side would mean handing a secret to the layer the key exists
  to distrust.
- **The target is frozen for the renderer's lifetime**, and `getActiveTarget()`
  throws if read before boot settles it — `'local'` would be a plausible wrong
  answer whose failure mode is cloud traffic quietly hitting the laptop.
  Switching reloads the window; see the toggle for why that is not a shortcut.
- **Switching tears down the quick-dispatch launcher.** It is pre-created at
  startup and destroyed only at quit, so it caches its base URL for the entire
  session. Left alone it would keep dispatching work to the previous Superagent
  after the main window switched — a divergence no storage change can fix, since
  the stale value is module state in a live renderer. `applyPreferredApiTarget()`
  destroys it; it is recreated, with the new target, on next use.

### Auth mode is resolved at boot, not at build

A cloud workspace *is* an auth-mode deployment, but every Electron build compiles
`__AUTH_MODE__` to `false`. With it false the UI reports `user: null`,
`isAdmin: false`, and grants every per-agent capability unconditionally. The
server still enforces (`AgentRead` / `IsAdmin`), so that is not a security hole —
but the UI offers every action on every agent and the user meets their real
permissions as a stream of 403s.

`lib/auth-mode.ts` therefore derives it: `__AUTH_MODE__ || targetIsRemote()`.
Derived rather than stored, so the two can never disagree.

- **It is frozen before first render, and that is load-bearing.**
  `useAuthSession()` and `useResolverAgents()` call hooks *conditionally* on this
  value behind a `rules-of-hooks` disable. That was sound when the value was a
  compile-time constant (one branch survived dead-code elimination) and is sound
  now only because the answer cannot change mid-lifetime: `setActiveTarget()`
  throws on a second assignment, and switching targets reloads. Reading it before
  boot settles the target throws too — a module that read it early would take a
  branch later renders contradict, which surfaces as a hooks-order crash that
  reproduces only in cloud mode.
- **Two questions, not one.** `isAuthMode()` means "the API enforces identity".
  `hasInteractiveLogin()` means "there is a login form to offer" — true only for
  a web deployment. A cloud workspace's credential is the proxy's bearer, held by
  main; there is nothing to type.
- **The 401 handler is three-way** (`lib/api.ts`): local does nothing; web auth
  stashes the route and signs out; cloud does **neither**. `signOut()` there would
  try to revoke the deployment session the desktop's grant is bound to, and by
  the time a 401 surfaces the proxy has already re-minted and retried once (see
  above) — so it means the mint failed, not that a user needs to log in again.
- **But returning the 401 is not enough on its own.** A rejected request and the
  session are separate state; in web auth mode the sign-out collapses them, and
  in cloud mode nothing does. Left alone, the session store keeps its last good
  value and the UI goes on claiming to be signed in while every query fails
  behind it. `lib/cloud-session.ts` carries the signal: `apiFetch` reports, and
  `UserProvider` re-fetches the session. That resolves it honestly — if the token
  really is dead, `get-session` 401s too and Better Auth nulls the session, which
  is what surfaces `<WorkspaceReconnect/>`. A burst of simultaneous 401s is
  collapsed into one re-check.
- **"Sign out" is not offered in cloud mode.** Auth mode being on is what makes
  that menu appear at all, but revoking the deployment session is both disruptive
  and pointless — main still holds the platform connection and would mint another.
  The menu offers a return to local instead (`switchToLocalTarget()`).
- **`AuthGate` offers reconnection, not a password.** `<WorkspaceReconnect/>`
  replaces `<AuthPage/>` when a cloud session reads null, and its primary action
  is returning to local — otherwise a user whose token died is stuck in a mode
  with no UI to leave it.
- **The auth client is built on first use, not at import.** Its `baseURL` must be
  the same base every other call site prefixes, and in cloud mode that is the
  keyed proxy prefix — which main only reveals during `initApiBaseUrl()`.
  `auth-client.ts` is imported (via `user-context`) while the module graph is
  still evaluating, *before* that runs, so an eagerly-built client would point at
  the local API forever.

## Electron-only, by design

The whole feature no-ops off the Electron main process (`process.type === 'browser'`
on the backend; `isElectron()` gates the renderer card). A cloud deployment
discovering *itself* is meaningless and can create deployment→deployment loops,
so it must never run inside an auth-mode web deployment.

## Security posture (don't regress these)

- **Raw member-bound bearer for discovery.** `GET /v1/me/deployments` rejects
  org-runtime JWTs and any `token::memberId` attribution suffix. The client uses
  a controlled `fetch` with the raw token — **not** `fetchPlatformJson`, whose
  global-fetch interceptor would append `::memberId` and get rejected.
- **SSRF / grant-leak guard.** The deployment URL comes off the wire, so it is
  treated as hostile input. Before minting or exchanging, the service requires
  `deployment_url === authorization_server` (the grant's `aud` is bound to
  `authorization_server`; sending it elsewhere would leak it) and runs the URL
  through the DNS-resolved private-host policy (`validateMcpDiscoveryUrl` in
  `utils/url-safety.ts`), requiring TLS off-loopback. Anything unsafe **fails
  closed** to not-found — no grant is ever sent.
- **No loopback in shipped builds.** `url-safety`'s *default* localhost
  exception opens up for any Electron main — correct for a user-configured local
  MCP server, wrong for a remotely supplied URL, which could otherwise be aimed
  at the user's own machine. This flow therefore passes an **explicit**
  `allowLocalhost`, true only when `SUPERAGENT_IS_PACKAGED === '0'` (published
  from `app.isPackaged` by the Electron main entry on every launch) or
  `E2E_MOCK === 'true'`. Both are exact-value checks — env vars are strings, so
  a presence test would also open this up for `E2E_MOCK=false`. Unset counts as
  packaged.
- **The exchange is a pinned fetch.** The one call carrying a credential to a
  remote host goes through `mcpSafeFetch`, not bare `fetch`: the socket is
  pinned to the vetted resolved address (so a DNS rebind between validation and
  connect can't redirect it) and redirects are followed manually (so a 307/308
  can't replay the assertion body onto another origin). Discovery and the grant
  mint target *configured* platform hosts and use plain `fetch`.
- **Nothing cached across accounts.** The React Query key includes the org, and
  connect/reconnect calls `resetQueries` (not `invalidateQueries` — that keeps
  serving stale data while refetching) so one account's deployment URL can never
  render behind a live "Open" button under another account.
- **Fail closed, always.** A poisoned/mismatched/unreachable record must never
  crash the app or leak a credential.

## Config

| Var | Host | Used for |
| --- | --- | --- |
| `PLATFORM_PROXY_URL` | proxy | discovery (`/v1/*`) |
| `PLATFORM_AUTH_ISSUER_URL` | auth issuer | grant mint (`/token/deployment-assertion`) |
| `PLATFORM_BASE_URL` | web/login | *not used by this flow* |

These are injected at build time as `__PLATFORM_*__` globals (see `vite.config.ts`
/ `electron.vite.config.ts`) and read env-first at runtime (`platform-auth/config.ts`).
`PLATFORM_AUTH_ISSUER_URL` is wired into all build workflows + a repo secret.

## Code map

| File | Responsibility |
| --- | --- |
| `platform-auth/cloud-workspace-schema.ts` | Wire schemas (Zod) + protocol constants |
| `platform-auth/cloud-workspace-client.ts` | The 3 calls (discovery, grant, exchange), raw-bearer fetch |
| `platform-auth/cloud-workspace-record.ts` | Settings persistence (dep-free, breaks cycles) |
| `services/cloud-workspace-service.ts` | `getCloudWorkspace()` — the discover→ensure-token algorithm + SSRF gate |
| `services/cloud-proxy-key.ts` | The per-boot secret in the proxy URL prefix |
| `services/cloud-proxy-target.ts` | What the proxy forwards to; single-flight, rate-limited re-mint |
| `api/routes/cloud-proxy.ts` | `/cloud/{key}/api/*` → the deployment (HTTP + SSE) |
| `main/cloud-stream-proxy.ts` | The same, for WebSocket upgrades |
| `shared/lib/api-target.ts` | The target types + pure resolution; fails closed to local |
| `services/api-target-preference.ts` | The stored preference (main-owned, so all renderers agree) |
| `main/api-target.ts` | Settles the target per renderer; tears down the launcher on a switch |
| `renderer/lib/api-target.ts` | The settled target, frozen for the renderer's lifetime |
| `renderer/lib/auth-mode.ts` | Auth mode + whether a login form exists, both derived from the target |
| `renderer/lib/auth-client.ts` | Better Auth client, built on first use so it can see the cloud prefix |
| `renderer/components/auth/workspace-reconnect.tsx` | The no-session screen for cloud mode, and the way back to local |
| `renderer/lib/cloud-session.ts` | Carries a cloud 401 into the session store, since signing out is not an option |
| `api/polyfill-api-prefix.ts` | Keeps dashboard-shim API calls on whichever API served the document |
| `services/platform-service.ts` | Boot/connect refresh + the background maintenance poll |
| `services/platform-auth-service.ts` | Clears the record on disconnect / identity change |
| `api/routes/platform-auth.ts` | `GET /api/platform-auth/deployments` route |
| `renderer/hooks/use-cloud-workspace.ts` + `settings/platform-tab.tsx` | The Account-tab card (Electron-gated); query key is org-scoped |

## Related

- The **receiving** side — `POST /api/auth/token/exchange` on the deployment
  (RFC 7523 JWT bearer) — is the host-app token-exchange feature. When it lands,
  see `docs/cross-client-auth.md` for the platform-side grant issuance and the
  deployment-side session minting.
- The platform endpoints (`/v1/me/deployments`, `/token/deployment-assertion`)
  live in the Gamut platform repo.

## Validating it for real

Unit tests here mock the network layer wholesale — `fetch`, `mcpSafeFetch`, and
the SSRF validator are all stubbed — so a green run says nothing about the
transport, the wire schemas, or whether the host policy rejects the right
things. The **`electron-cloud-interface-validation` skill**
([.claude/skills/electron-cloud-interface-validation/SKILL.md](../.claude/skills/electron-cloud-interface-validation/SKILL.md))
stands up the real three-node stack and runs the 14-check gated live suite
(`cloud-workspace-service.live.test.ts`, `LIVE_E2E=1`). Run it before merging
anything that touches this chain.

## Running it locally

Standing up an end-to-end stack means running **three** nodes (platform auth +
proxy, an auth-mode deployment as the "cloud workspace", and this app as the
Electron client) against local Supabase, plus seeding an `org_deployment` row.
The reusable recipe (seed SQL, ops env-bundle, the `?raw`/`AUTH_MODE` build
gotchas, the redirect-URI fix) is captured in the team's engineering notes rather
than here, since it depends on local platform infrastructure.

A local stack is all loopback, so the run must look unpackaged —
`electron-vite dev` publishes `SUPERAGENT_IS_PACKAGED=0` for you; a harness
driving the service outside Electron has to set it (and `process.type`) itself.
Without it the loopback deployment is refused by design and the workspace shows
as not-found.
