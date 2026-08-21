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
- **A dashboard's own urls get the prefix back; nothing else does.** A dashboard
  iframe is loaded from the keyed URL, and `cloud-proxy.ts` substitutes the
  prefix onto occurrences of that dashboard's own mount in html, javascript and
  css bodies — without it a root-absolute entry module resolves against the
  *loopback* origin, 404s on the local API, and the dashboard renders blank. Any
  other `/api/...` inside the document is left alone. The
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

### The boot round trips start before the renderer does

Switching targets reloads the window, and nothing remote begins until that
reload has finished, React has mounted and `UserProvider` has reached
`get-session`. The reload and the network wait were strictly serial, so a switch
cost one before the other.

Main does not have to wait. It is told the new target *before* the reload starts
(`applyPreferredApiTarget`) and it already holds the deployment token, so
`cloud-boot-prefetch.ts` makes the boot calls itself — the session the auth gate
blocks on, the two settings reads, the agent list — and the proxy answers the
renderer from them. The same thing runs on a cold start into a cloud workspace,
where the wait is identical.

What is saved is the head start, not a cached response. A renderer arriving
mid-flight waits on the *same* request instead of opening a second one, and it
also finds the TLS connection warm, since the pool belongs to this process and
outlives the reload.

It is deliberately not a cache, and the rules are what keep it from becoming
one:

- **One request per entry.** A refetch a second later is someone asking for
  fresh data; this must never be why they get stale data.
- **Only a 200 is replayed.** A 401 needs the proxy's refresh-and-retry, and
  handing over this copy would skip it.
- **The token and deployment are compared at use.** An entry started under a
  token that has since been refreshed is worthless, and comparing here rather
  than clearing from the refresh path keeps the module a leaf.
- **Exact path match, GET only, no conditional or range headers.** A 304 or a
  partial body is a different question from the one main asked. A miss costs
  nothing but the request that would have happened anyway.
- **Entries leave on their own, and the flights are bounded by the same clock.**
  A boot that lands somewhere unpredicted — a login screen, a workspace needing
  reconnection — claims none of them, and responses fetched under a credential
  that may since have been replaced must not sit in memory for the life of the
  process. Bounding the flight matters for the opposite reason: a renderer that
  claims an entry *awaits* it, so an unbounded request would hold up the very
  call it was meant to accelerate.

Two of the prefetched paths are not on the critical path but are *chained*:
Explore appears only once skillsets have loaded and then the agents they make
discoverable, so it arrives two round trips after the nav around it and pushes it
down on the way in. `useRememberedFlag` covers the same gap from the other side,
showing this target's previous answer until the real one lands — the two are
belt and braces, and neither is enough alone (the memory is empty on a first
visit; the prefetch does nothing for a local boot).

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
- **And it must be handed the *auth* base, not the API base.** better-auth
  appends its default `/api/auth` only to a base URL that has no path of its own:
  `withPath()` returns the URL untouched once `checkHasPath()` is true. A local
  base is a bare origin and gets the default for free; a cloud base is
  `http://localhost:{port}/cloud/{key}`, which already has a path, and does not.
  Passing the raw base therefore sent every session lookup to
  `/cloud/{key}/get-session` — a 404, which is indistinguishable from a dead
  session, so the app showed `<WorkspaceReconnect/>` against a workspace that was
  answering perfectly well. **Cloud mode was unusable and every unit test was
  green**, because the test asserted the value we pass rather than the URL
  better-auth builds from it. `resolveBaseUrl()` appends `/api/auth` itself,
  which is a no-op for local and web and the whole fix for cloud.

### Choosing the target

`TargetSwitcher` is the segmented Local/Cloud control, and `useTargetSwitch`
holds the logic. It sits at the head of the sidebar's title bar row, ahead of
history and search: it scopes everything below it, so it reads as a property of
the whole window rather than one more menu item. That row is a fixed 48px shared
with the macOS traffic lights, so the control shows icons only and reveals its
labels on hover (and on focus, for keyboard users), pushing the buttons after it
past the right edge while open.

- **Hidden unless there is somewhere to go.** A single-machine user never sees a
  control with one real option.
- **Availability is asked only from the local side.** This is the trap:
  `GET /api/platform-auth/deployments` goes through `apiFetch`, so *in cloud mode
  it travels through the proxy to the deployment* — and `getCloudWorkspace`
  self-gates off the Electron main process, so the deployment answers
  "no workspace" about itself. Believing that would hide the control exactly when
  the user needs it to get back. Being in cloud mode is its own proof of
  reachability, so the query is disabled there.
- **Switching reloads onto `/`, never in place.** Agent ids are per-deployment,
  so the route you are standing on almost certainly does not exist on the other
  side; reloading in place lands on a 404 of someone else's agent. Electron uses
  hash history, so that means setting the fragment and reloading (the document
  URL must stay pinned to the real `index.html`); the web build assigns `/`.
- **The React Query cache is cleared once the write has succeeded**, not before.
  The reload drops it anyway; clearing only keeps the previous Superagent's data
  off screen for the moment it takes the navigation to commit. Doing it up front
  used to mean a failed IPC write left an *empty* UI behind a permanently
  disabled control.
- **A failed switch is recoverable.** The preference write is IPC and can reject
  (settings unwritable, main gone). Nothing has changed when it does, so
  `switching` is released and the failure is reported, rather than latching the
  control on a window that is not going anywhere. Everything that switches goes
  through this one path — the user menu's "Use this computer" included — except
  `WorkspaceReconnect`, which reports inline because no toaster is mounted on
  that screen.
- Recording the preference also tears down the quick-dispatch launcher (main does
  that), so the control only owns *this* window.
- Main's own agent-listing surfaces — the system tray and the app menu's Agents
  submenu — follow the switch too. They resolve the effective base URL (local, or
  the keyed proxy prefix) on every poll via `fetchAgentsWithStatus`, and
  `applyPreferredApiTarget` rebuilds them immediately so the previous
  Superagent's agents don't sit in the menus for up to a poll interval. Agent
  deep links resolve their session lookup against the same effective base, since
  the renderer will interpret the slug on whichever Superagent it is driving.

**The switch is animated from outside the document.** The reload is what makes
the switch safe — every module-scoped cache, open stream and memoized client
dies with the page, so nothing has to remember to reset itself — which also means
nothing rendered by the page can survive to animate it. So main layers a
`WebContentsView` over the window (`main/target-switch-overlay.ts`): its own
document, in its own process, untouched by the reload underneath. Under the band
sits a `capturePage` still of the outgoing view, because for a moment during the
reload there is genuinely nothing to show.

The still dissolves the moment the new view exists underneath it, which is
usually part-way through the crossing — so the change of contents happens *during*
the wave rather than as a cut when it leaves. The band goes on travelling over
the new view until its pass is done.

The band is held for one full crossing even when the new view arrives sooner:
the fastest leg — back to this computer, where nothing is fetched from anywhere —
was over before the animation was legible, and a transition that flickers past
reads as a glitch.

The renderer awaits the overlay before reloading (a band raised afterwards covers
the blank it was meant to hide) and signals from `AuthGate` once the boot has
settled on something to display — the reconnect screen and the login form count,
not just the shell. **It fails open**: a watchdog removes the overlay regardless,
because it swallows input while it is up, and one stuck on screen is an app that
looks frozen.

### How a window says which Superagent it is driving

The main window says it through the sidebar switcher alone: the selected option
is the state. It previously also carried a screen-sized frame and a "Cloud
workspace" strip; that was removed as too loud for a state the switcher already
shows on every screen. Collapsed, that state is the raised icon — laptop or
cloud — which is why the two options must stay visually distinguishable without
their labels.

The **quick-dispatch launcher** keeps its own marker, and the reason is not
symmetry: it is a separate renderer with no router and no switcher, and it can
create a session on the organization's Superagent straight from a global
shortcut — a window with no other way to tell you where that session is going.
So it carries a sky ring on the panel and a full-width "Cloud workspace" strip
above the input (`quick-dispatch.tsx`). Anything that grows into a window of its
own needs to answer the same question somehow, whether by a switcher or a mark.

`setActiveTarget()` also stamps `<html data-api-target="local|cloud">`. Nothing
in the app reads it — it is there so an out-of-process observer (the live suite,
over CDP) can ask a renderer what it settled on without inferring it from
whatever chrome is on screen. The switcher is not usable for that: the
onboarding wizard replaces the whole shell, so "no switcher" and "the switch
never happened" would look identical.

### Capability gating: three questions, not one axis

Three predicates decide what a window offers. They look like one scale of
strictness, they are not, and mistaking them for one has already shipped a
regression — so the distinction is worth holding precisely.

| Predicate | Definition | Asks |
| --- | --- | --- |
| `isElectron()` (`renderer/lib/env.ts`) | native window + preload bridge present | Is there a *window* of ours here? |
| `targetIsRemote()` (`renderer/lib/api-target.ts`) | the settled target is `cloud` | Is the API a machine other than this one? |
| `canUseHostFeatures()` (`renderer/lib/host-features.ts`) | `isElectron() && !targetIsRemote()` | May this window act on *this* computer on the agents' behalf? |

Only three configurations are reachable. A browser never has a cloud target:
`initApiBaseUrl()` settles every web renderer to `local`, because there is no
stored preference and no proxy prefix to read.

| Configuration | `isElectron()` | `targetIsRemote()` | `canUseHostFeatures()` | `!targetIsRemote()` |
| --- | --- | --- | --- | --- |
| Electron → local API | yes | no | **yes** | **yes** |
| Electron → cloud workspace | yes | yes | **no** | **no** |
| Web build (any deployment) | no | no | **no** | **yes** |

So `canUseHostFeatures()` does narrow `isElectron()` — by exactly one row. But
read the last column. `!targetIsRemote()` is *true* where `isElectron()` is
false: it is **broader** than `isElectron()`, not narrower. The two predicates
are conjunctions of two independent questions, not points on a scale, and they
disagree in a configuration we ship to every browser.

**The rule that holds up: ask what the feature touches, not what the window is.**

| The feature acts on… | Use | Because |
| --- | --- | --- |
| this computer, for the agents | `canUseHostFeatures()` | it needs the bridge *and* needs both machines to be the same one |
| the machine running the API | `!targetIsRemote()` | a web deployment legitimately offers it — the API *is* the machine the user means |
| the window itself | `isElectron()` | traffic lights, drag regions, tray, updates, the global shortcut: the target is irrelevant to whether the feature *exists* (what the tray and app menu *list* is a target question — they resolve the effective base URL, see the switch section) |

The first two questions used to be one. Every host-touching feature asked
`isElectron()`, which was correct for as long as the desktop app could only
drive the Superagent on its own machine. In cloud mode it is still Electron —
the bridge answers, the directory picker opens, `showInFolder` works — but they
now reach *this* laptop while the agents, their files and their runtime are
somewhere else.

#### Acts on this computer → `canUseHostFeatures()`

| Site | Why |
| --- | --- |
| Add-a-mount, and the Volumes section when empty (`use-mounts.ts`, `home-volumes.tsx`) | The picker browses this computer; the path is handed to the agent's |
| Open-a-mount in Finder/Explorer (`home-volumes.tsx`) | `hostPath` belongs to the agent's machine |
| Reveal a workspace file (`folder-file-context-menu.tsx`) | The deployment returns *its* host path; opening it here lands nowhere, or on a same-named folder of yours |
| Show Agent Directory (`agent-context-menu.tsx`) | `open: true` makes the API run the file manager on **its own** host. Remotely this becomes the copy-the-path action the web build already uses |
| Computer Use — the settings tab and the System Settings recovery link (`global-settings-page.tsx`, `computer-use-request-item.tsx`) | It drives the machine the agent runs on, and its whole UI is written for that being yours. The missing-permission *list* still shows remotely; only the button that would fix the wrong computer is withdrawn |
| Dropped/picked folder paths (`file-utils.ts`, `use-message-composer.ts`) | A `folderPath` exists only to be mounted or read by the agent's machine. Remotely, the web route — enumerate and upload the bytes — is the only one that works, and the mount/upload choice is not offered |

#### Acts on the API's machine → `!targetIsRemote()`

These act on the **server**, and a web deployment legitimately offers them — the
API being configured is exactly the machine the user means. Gating them on
`canUseHostFeatures()` withdraws them from every browser, not just from cloud
mode, because that predicate is false in the whole bottom row of the table
above.

| Site | Why not `canUseHostFeatures()` |
| --- | --- |
| The wizard's runtime step (`stepsForPath` in `getting-started-wizard.tsx`) | Self-hosted web onboarding has to set up its own runtime |
| The container-setup modal (`container-setup-handler.tsx`) | Same, outside the wizard |
| Firewall detection (`use-firewall-status.ts`) | A web deployment can be behind its own firewall |
| The login form (`hasInteractiveLogin()` in `auth-mode.ts`) | A web auth-mode deployment has a password to type; a cloud workspace's credential is the proxy's bearer, held by main |

What disqualifies these in cloud mode is that the machine is out of reach — its
runtime is already provisioned, and its UAC prompt is somewhere nobody here can
answer — not that there is no IPC bridge. Getting this wrong shifted every
wizard step for web users, and the wizard E2E was the *only* thing that caught
it.

#### Shown *because* the target is remote → `targetIsRemote()`

| Site | Purpose |
| --- | --- |
| `quick-dispatch.tsx` | The launcher's own ring + strip — the one window with no switcher to read |
| `auth-gate.tsx` | `WorkspaceReconnect` instead of a login form |
| `auth-mode.ts` | `isAuthMode()` is `__AUTH_MODE__ \|\| targetIsRemote()` — a cloud workspace *is* an auth-mode deployment |
| `main/dashboard-window.ts` | Proxy confinement, base-URL-scoped identity, and the "Cloud workspace — " title prefix |
| `main/api-target.ts` | Tears down the launcher and all popouts on a switch |

**Not gated at all, deliberately.** Where the answer comes from the *server* it
already comes from the machine that owns it: the host-browser providers and their
Chrome profiles (`detectAllProviders()`), STT availability
(`/api/stt/configured`), and runtime readiness all describe whichever Superagent
is being driven. The runtime banner in the sidebar keeps reporting an unavailable
cloud runtime — that is true wherever it comes from; only the offer to fix it
here is not.

#### Known soft spots

None of this is enforced. There is no lint rule, roughly a hundred raw
`window.electronAPI` reads and ~47 `isElectron()` sites, and nothing stops the
next feature from asking the old question. Specifically, and unfixed:

- **`handleAddMount` (`use-mounts.ts`) is itself ungated** — only the button that
  calls it consults `canAddMount`. A second caller reintroduces the host-path
  leak.
- **Dock shortcuts carry no target.** `create-dock-shortcut` stores
  `agentSlug`/`dashboardSlug` only, and the deep-link handler opens them against
  whatever target is active at click time. A shortcut made for a cloud dashboard
  silently opens the local agent of the same slug, or 404s.
- **Recent-files attach is on a raw `!!window.electronAPI?.getRecentFiles`**
  (`attachment-picker.tsx`, `quick-dispatch-menus.tsx`). This one is *correct* —
  it uploads bytes, not paths, so it works against a workspace exactly as a
  browser file picker does — but it reads like the oversights above, so leave the
  reasoning attached to it.

### Dashboard popouts

Corrected rather than hidden, and they need three separate things because the
window is built in main, where there is no renderer to ask.

1. **The document URL.** `openDashboardWindow` used to hard-code
   `http://localhost:<port>`; it now takes `activeApiTarget().baseUrl`, so a
   popout follows the window it was opened from.
2. **Everything the document then requests.** Only that outer URL carries the
   proxy prefix. The `/view` wrapper the deployment serves back builds its status
   poll, its start-the-agent POST and its iframe from a root-relative
   `/api/agents/{slug}` — which resolves against the laptop's own API. So the
   popout's own session (a per-window partition, never the default one) carries
   an `onBeforeRequest` rewrite that puts unprefixed `/api/` calls back through
   the proxy. Done here rather than in the wrapper because the wrapper is
   generated by the *deployment*: a fix there only reaches workspaces new enough
   to have it, and this has to hold against whatever version an organization is
   running.
3. **Identity and lifetime.** The dedup key includes the base URL — two
   deployments can hold an agent of the same slug — and `applyPreferredApiTarget`
   closes all popouts on a switch, since each already loaded a URL built from the
   old base.

They also carry the cloud marker, as the "every window" rule requires: main
intercepts `page-title-updated` and prefixes "Cloud workspace — ". The title is
the only surface main owns here; a frame would mean writing into an
agent-generated document.

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
| `services/cloud-boot-prefetch.ts` | The boot round trips, started before the reloading renderer can ask |
| `api/routes/cloud-proxy.ts` | `/cloud/{key}/api/*` → the deployment (HTTP + SSE) |
| `main/cloud-stream-proxy.ts` | The same, for WebSocket upgrades |
| `main/target-switch-overlay.ts` | The band over the window while a switch reloads it |
| `shared/lib/api-target.ts` | The target types + pure resolution; fails closed to local |
| `services/api-target-preference.ts` | The stored preference (main-owned, so all renderers agree) |
| `main/api-target.ts` | Settles the target per renderer; tears down the launcher on a switch |
| `renderer/lib/api-target.ts` | The settled target, frozen for the renderer's lifetime |
| `renderer/lib/auth-mode.ts` | Auth mode + whether a login form exists, both derived from the target |
| `renderer/lib/auth-client.ts` | Better Auth client, built on first use so it can see the cloud prefix |
| `renderer/components/auth/workspace-reconnect.tsx` | The no-session screen for cloud mode, and the way back to local |
| `renderer/lib/cloud-session.ts` | Carries a cloud 401 into the session store, since signing out is not an option |
| `renderer/hooks/use-target-switch.ts` | Which target, whether the other is reachable, and how to move |
| `renderer/components/layout/target-switcher.tsx` | The segmented Local/Cloud control |
| `renderer/lib/host-features.ts` | Whether this window may act on the computer it runs on |
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
things. There are two live suites, and they cover different halves.

**The chain** — discovery → grant → exchange → persisted token. The
**`electron-cloud-interface-validation` skill**
([.claude/skills/electron-cloud-interface-validation/SKILL.md](../.claude/skills/electron-cloud-interface-validation/SKILL.md))
stands up the three-node stack and runs the 14-check gated suite
(`cloud-workspace-service.live.test.ts`, `LIVE_E2E=1`). It drives the service
in-process; no app, no windows.

**The app** — [`e2e/live/cloud-electron/`](../e2e/live/cloud-electron/README.md)
launches the real desktop app with a remote debugging port and drives it over
CDP against the same stack: 28 checks across target resolution, onboarding on
the remote workspace, whether cloud mode reaches a *different machine's* data,
capability gating, restart persistence, and the way back to local. Run it before
merging anything that touches the proxy, the target, auth mode or the gating
predicates.

That second suite exists because the first one cannot fail on the app's
behaviour. The better-auth base-URL bug above made cloud mode entirely unusable
while 8,255 unit tests, the whole Playwright suite and all 14 live chain checks
stayed green — nothing in any of them ever asked a real renderer to render.

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
