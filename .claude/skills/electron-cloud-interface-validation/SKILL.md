---
name: electron-cloud-interface-validation
description: Stand up the three-node local stack (platform auth + proxy, a remote auth-mode deployment, this app as the Electron client) and run the gated live suite that proves the cloud-workspace chain — discovery → RFC 8693 grant → RFC 7523 exchange → persisted deployment token. Use when changing anything under cloud-workspace-*, the token-exchange endpoint, the platform grant/discovery endpoints, or before merging a PR that touches them.
---

# Electron ↔ cloud workspace: live validation

This spins up **real infrastructure** and runs
`src/shared/lib/services/cloud-workspace-service.live.test.ts` against it. Unit
tests for this feature mock the network layer wholesale, so they cannot catch a
broken transport, a schema mismatch on the wire, or an SSRF policy that rejects
the wrong thing. This is the only check that does.

Read [docs/cloud-workspace.md](../../../docs/cloud-workspace.md) first for the
architecture. This file is the runbook.

## Why this exists

The feature spans **three independent parties**, and mocks sit at every seam:

| Node | What it is | Port |
| --- | --- | --- |
| **Platform auth issuer** | OIDC + `POST /token/deployment-assertion` (mints the grant) | 3002 |
| **Platform proxy** | `GET /v1/me/deployments` (discovery) | 8787 |
| **Cloud workspace** | An **auth-mode deployment — another build of this same app** — serving `POST /api/auth/token/exchange` | 8899 |
| *(the client)* | This repo's service code, driven by vitest in-process | — |

The unit suite stubs `fetch`, `mcpSafeFetch`, and `validateMcpDiscoveryUrl`. A
green unit run therefore says nothing about whether the pinned undici agent
mangles the form POST, whether the deployment's Zod schema accepts what the
platform actually sends, or whether the real DNS-resolving SSRF policy rejects a
loopback target. Those are exactly the failures this suite catches.

## Prerequisites

- **Local Supabase running** on 54321/54322 (`supabase start` in the platform
  repo). Check: `lsof -nP -iTCP -sTCP:LISTEN | grep 54321`.
- **A platform checkout that has the endpoints** — see trap 1 below.
- **An app checkout that has the token-exchange route** — see trap 2 below.
- `psql`, `openssl`, `npx` on PATH.

## The two traps (read before starting)

These produce confusing symptoms and each costs a full debugging cycle.

### Trap 1 — the platform endpoints may live in a worktree, not the main checkout

If `/token/deployment-assertion` and `/v1/me/deployments` are unmerged, the main
platform checkout **404s both**. Verify before starting:

```bash
ls $PLATFORM_WORKTREE/apps/auth/src/token/deployment-grant.ts
ls $PLATFORM_WORKTREE/apps/proxy/src/me-deployments.ts
```

Both must exist. If they don't, find the worktree that has them
(`ls -d ~/Dropbox/SkillfulAgents/platform/.claude/worktrees/*`) and point
`PLATFORM_WORKTREE` there.

**Symptom if you get this wrong:** every check fails with
`Deployment discovery failed (404)` / `Grant request failed (404)`.

### Trap 2 — node 3 must be built from a branch that HAS the receiving endpoint

The "cloud workspace" is a build of *this* app, and it must contain
`src/api/routes/token-exchange.ts`. A feature branch cut before that landed will
serve a 404. Verify:

```bash
ls src/api/routes/token-exchange.ts   # in whichever checkout you build node 3 from
```

Build node 3 from `main` (or a branch that includes it), **not necessarily from
the branch under test** — node 3 is the *remote peer*, not the code being
validated.

**Symptom if you get this wrong:** the exchange returns 404 and `hasValidToken`
is false while discovery works fine.

## Procedure

Pick a scratch dir and export the two paths everything else derives from:

```bash
export WORKDIR=/tmp/cloud-live && mkdir -p $WORKDIR
export PLATFORM_WORKTREE=~/Dropbox/SkillfulAgents/platform/.claude/worktrees/<the-one-with-the-endpoints>
export APP_ROOT=$(pwd)                      # the checkout under test
export NODE3_ROOT=<checkout that has token-exchange.ts>
```

### 1. Seed Supabase

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f seed.sql
```

Creates a confirmed auth user, an org, an active member, a `plat_sa_` access
key, and an `org_deployment` row pointing at `http://127.0.0.1:8899`. All ids are
fixed literals so cleanup can never touch real data.

Notes on the fixtures:
- The access key is **plaintext-matched** in `access_key.key` (no hash) and must
  be ≥32 chars. `client_instance_id = NULL` skips the supersede check.
- The user needs a real bcrypt password (`crypt(...)`) only if you also want to
  drive the browser login flow.

### 2. Start the auth issuer (3002)

```bash
./start-auth.sh > $WORKDIR/auth.log 2>&1 &
sleep 8 && grep -E "ops_routes_enabled|ready" $WORKDIR/auth.log
```

You must see **both** `ops_routes_enabled` and `ready`. If you only see `ready`,
check for `ops_routes_disabled_bad_token` — `OPS_ADMIN_TOKEN` must be ≥32 bytes,
and the server starts happily without ops routes, so this fails silently later
at the env-bundle step.

### 3. Start the proxy (8787)

```bash
cd $PLATFORM_WORKTREE/apps/proxy
npx wrangler dev --port 8787 --inspector-port 9247 \
  --persist-to ../../.wrangler/shared-state > $WORKDIR/proxy.log 2>&1 &
```

**Pick a free inspector port.** The default 9230 is often taken by another
project's wrangler; the error is `Address already in use (127.0.0.1:9230)` and it
kills the whole start, not just the inspector. Never kill someone else's
wrangler to free it — just use another port.

Verify both platform nodes answer (401/400, **not** 404):

```bash
curl -s -o /dev/null -w "discovery:%{http_code}\n" http://127.0.0.1:8787/v1/me/deployments
curl -s -o /dev/null -w "grant:%{http_code}\n" -X POST http://127.0.0.1:3002/token/deployment-assertion
```

### 4. Issue the org env bundle

This registers the OIDC client **and** mints the org-runtime `PLATFORM_TOKEN`
node 3 needs:

```bash
curl -s -X POST http://127.0.0.1:3002/ops/issue-org-env-bundle \
  -H "Authorization: Bearer $OPS_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"org_id":"org_11111111-1111-1111-1111-111111111111",
       "confirm_org_id":"org_11111111-1111-1111-1111-111111111111",
       "redirect_uris":["http://127.0.0.1:8899/api/auth/oauth2/callback/platform",
                        "http://127.0.0.1:8899/api/auth/callback/platform"]}' \
  -o $WORKDIR/bundle.json -w "%{http_code}\n"
```

`platform_token` is a top-level field; `AUTH_PROVIDERS_JSON` only appears inside
`env_block` and must be grepped out of it. Write `$WORKDIR/node3.env`:

```
AUTH_MODE=true
PORT=8899
TRUSTED_ORIGINS=http://127.0.0.1:8899
BETTER_AUTH_SECRET=live-e2e-secret-0123456789abcdef0123456789abcdef
SUPERAGENT_DATA_DIR=$WORKDIR/node3-data
PLATFORM_TOKEN=<bundle.platform_token>
AUTH_PROVIDERS_JSON=<from bundle.env_block>
```

Both are required: the exchange endpoint gates on the platform auth provider
being **enabled**, so a missing `AUTH_PROVIDERS_JSON` makes it 404 exactly like a
missing route.

### 5. Build and start node 3 (8899)

```bash
cd $NODE3_ROOT
AUTH_MODE=true npm run build:web    # AUTH_MODE at BUILD time — see below
npm run build:api
rm -rf $WORKDIR/node3-data && mkdir -p $WORKDIR/node3-data
node --env-file=$WORKDIR/node3.env dist/web/server.mjs > $WORKDIR/node3.log 2>&1 &
```

Two hard requirements:
- **Run the tsup bundle (`dist/web/server.mjs`), never `tsx` directly.** Plain
  `tsx` cannot handle the Vite-style `?raw` markdown imports and clobbers
  `Module._extensions`, so it dies with `SyntaxError: Invalid or unexpected
  token` in a `.md` file. Only `npm run build:api` (tsup's `rawLoaderPlugin`)
  handles them.
- **`AUTH_MODE=true` must be set at `build:web` time**, not just at runtime.
  `__AUTH_MODE__` is baked into the renderer bundle; build it without and the
  `AuthGate` is compiled out, so the SPA loads and every API call 401s instead of
  showing a login page. Irrelevant to the vitest suite (no browser), critical if
  you're demoing in a browser.

Verify (expect `{"error":"invalid_grant"}` with 400 — **not** 404):

```bash
curl -s -X POST http://127.0.0.1:8899/api/auth/token/exchange \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=bogus" -w "\n%{http_code}\n"
```

### 6. Run the suite

```bash
./run-live-suite.sh
```

Expect **14 passed**. The suite is hard-gated on `LIVE_E2E=1` and is a no-op
otherwise (its hooks live inside the gated `describe`, so a normal run creates no
temp dirs and touches no settings — keep it that way).

## What the 14 checks prove

| | Check | Catches |
| --- | --- | --- |
| — | Harness env present | Silent misconfiguration |
| ① | Discovery returns the seeded workspace | Proxy route, bearer handling, wire schema |
| ② | Grant is well-formed and correctly scoped | `alg`/`typ`/`kid`, `aud` = deployment, `iss`, `org_id`, `email_verified`, ≤300 s lifetime |
| ③ | Grant exchanges for a session token, and **replay fails** | Single-use `jti` enforcement on the deployment |
| ④ | `getCloudWorkspace` finds it and persists a valid token | The whole client algorithm end to end |
| ⑤ | A valid stored token is **reused, not re-minted** | Accidental mint-per-view (checks `updatedAt` is untouched) |
| ⑥ | A token inside the 1 h buffer is re-minted | Refresh-buffer arithmetic |
| ⑦ | A token bound to another deployment URL is discarded | Deployment rebinding |
| ⑧ | Discovery **rejects an org-runtime JWT** | The member-bound-token requirement |
| ⑨ | The fingerprint round-trips through real `settings.json` | Zod `nullish().transform()` persistence |
| ⑩ | A record fingerprinted to another credential is re-minted | Cross-account token reuse |
| ⑪ | A **packaged** build refuses the loopback target, via the real DNS/SSRF policy | An SSRF gate that only works against a stub |
| ⑫ | The token minted **through the pinned fetch** authenticates at `/api/auth/get-session` | `mcpSafeFetch`'s undici agent mangling the form POST |
| ⑬ | An unreachable platform reports `discoveryFailed` and keeps the token | Treating an outage as confirmed absence |

⑪ and ⑫ are the ones that justify the whole exercise — no mock can stand in for
either.

## Teardown

```bash
pkill -f "node3.env"; pkill -f "tsx src/index.ts"; pkill -f "wrangler dev --port 8787"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f cleanup.sql
```

`cleanup.sql` prints four counts; **all must be 0**. Leave Supabase running if it
was running when you started. Before killing anything, confirm the target is
yours: `pkill -f "dist/web/server.mjs"` also matches unrelated app servers — key
off the unique `node3.env` argument instead.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| All checks fail with `(404)` | Platform services started from a checkout without the endpoints (trap 1) |
| Exchange 404s, discovery fine | Node 3 built from a branch without `token-exchange.ts` (trap 2), or `AUTH_PROVIDERS_JSON` missing from `node3.env` |
| Ops bundle returns 404/401 | `OPS_ADMIN_TOKEN` < 32 bytes — grep the auth log for `ops_routes_disabled_bad_token` |
| `Address already in use (127.0.0.1:9230)` | Another project's wrangler holds the inspector port; pass `--inspector-port 9247` |
| `SyntaxError` in a `.md` file | Node 3 launched via `tsx` instead of the tsup bundle |
| Browser loads the SPA but every call 401s | Renderer built without `AUTH_MODE=true` |
| `invalid_redirect_uri` during browser login | `oidc_client.redirect_uris` lacks `/api/auth/oauth2/callback/platform` (better-auth's genericOAuth path, **not** `/api/auth/callback/platform`); fix the row and restart auth to bust the client cache |
| JWKS fetch failures from the app | Auth bound to `localhost` (IPv6-only) — set `AUTH_BIND_HOST=127.0.0.1` |
| ⑪ fails (loopback allowed when packaged) | `SUPERAGENT_IS_PACKAGED` leaked as `0` into the environment |

## Optional: drive it in a real browser

Only needed to see the UI, not for the suite. Additionally start the platform web
app (`apps/web`, Next.js, :3000) — the auth server's interaction router redirects
to `{webOrigin}/auth/login` and renders no form of its own. For a desktop
Electron client alongside an installed build, use a fresh `SUPERAGENT_DATA_DIR`
and `SUPERAGENT_DISABLE_SINGLE_INSTANCE=1` (honored only when not packaged).

## Scope note

This validates the **client** side (this repo) against real peers. The platform
endpoints have their own suites in the platform repo; the deployment-side
exchange endpoint has unit coverage here. This skill is the seam between them.
