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
deployment. Today it is maintained but **not yet consumed by the UI** ("Open"
just navigates to `deployment_url`); it is infrastructure for a future SSO hop.

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
- **"No workspace" and "couldn't check" are different answers.** A discovery
  that fails (unreachable, 401, malformed) returns `discoveryFailed: true`, and
  the card offers a retry. Only a *successful* discovery listing none shows the
  create-a-workspace CTA — otherwise an outage would invite the user to create a
  second workspace they already have.
- The record is **principal-scoped**: it stores the `userId`/`memberId` **and a
  fingerprint of the platform credential** it was minted under, is only reused
  while all three still match, is cleared whenever the acting **org OR
  user/member** changes (`savePlatformAuth`) or on disconnect, and the principal
  is re-checked immediately before the write so a refresh still in flight across
  an account change can't resurrect the old token. A same-user metadata refresh
  does not churn it.
  The fingerprint is load-bearing, not belt-and-braces: `userId`/`memberId` can
  both be null on a connection whose introspection never filled them in, and on
  a *disconnected* app — so comparing only those makes two different accounts,
  or an account and no account, look identical. An unidentifiable principal is
  never equal to anything, including another unidentifiable one.
- Maintenance runs on boot, on connect, on Account-tab view, **and** on a
  low-frequency background poll in `PlatformService`, so a long-lived app stays
  valid without an Account visit.

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
| `services/platform-service.ts` | Boot/connect refresh + the background maintenance poll |
| `services/platform-auth-service.ts` | Clears the record on disconnect / identity change |
| `api/routes/platform-auth.ts` | `GET /api/platform-auth/deployments` route |
| `renderer/hooks/use-cloud-workspace.ts` + `settings/platform-tab.tsx` | The Account-tab card (Electron-gated) |

## Related

- The **receiving** side — `POST /api/auth/token/exchange` on the deployment
  (RFC 7523 JWT bearer) — is the host-app token-exchange feature. When it lands,
  see `docs/cross-client-auth.md` for the platform-side grant issuance and the
  deployment-side session minting.
- The platform endpoints (`/v1/me/deployments`, `/token/deployment-assertion`)
  live in the Gamut platform repo.

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
