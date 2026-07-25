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
- The record is **principal-scoped**: it is cleared whenever the acting
  **org OR user/member** changes (`savePlatformAuth`) and on disconnect. A
  same-user metadata refresh does not churn it.
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
- **SSRF / grant-leak guard.** Before minting or exchanging, the service requires
  `deployment_url === authorization_server` (the grant's `aud` is bound to
  `authorization_server`; sending it elsewhere would leak it) and runs the URL
  through the existing DNS-resolved private-host policy
  (`validateMcpDiscoveryUrl` in `utils/url-safety.ts`), requiring TLS except for
  the Electron/E2E loopback exception. Anything unsafe **fails closed** to
  not-found — no grant is ever sent.
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
