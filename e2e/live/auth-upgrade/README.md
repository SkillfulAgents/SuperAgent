# Better Auth upgrade and rollback validation

Runs real auth-mode API processes against one persistent, initially empty SQLite
database. The sequence is **1.6 → 1.7 → 1.6 rollback → 1.7 again**. Each process
uses its own built application and installed dependencies; all use the same
fresh test data directory, canonical URL and auth secret.

Prepare two isolated checkouts with their dependencies and `dist/web/server.mjs`
built: the pre-upgrade application on Better Auth 1.6, and this PR on 1.7. Build
in those isolated directories so the active development server's output is not
overwritten. Run from this PR's repository root:

```bash
set -o pipefail
AUTH_UPGRADE_BASELINE_DIR=/tmp/auth-baseline \
AUTH_UPGRADE_CURRENT_DIR=/tmp/auth-upgraded \
npx tsx e2e/live/auth-upgrade/run.ts 2>&1 | tee /tmp/auth-upgrade.log
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_UPGRADE_CURRENT_DIR` | Current working directory | Built application using Better Auth 1.7 |
| `AUTH_UPGRADE_PORT` | `33175` | Dedicated API port; an occupied port fails the run |
| `AUTH_UPGRADE_OUTPUT_DIR` | `/tmp/ba17-validation/auth-upgrade` | Sanitized proof and server logs; private database metadata snapshots |
| `AUTH_UPGRADE_KEEP_DATA` | Unset | Set to `true` only to retain the isolated test database for debugging |

The harness uses a real local HTTP OIDC authority with an RS256 signing key,
JWKS discovery, one-use authorization codes, and PKCE verifier/redirect-URI
checks. The application performs the actual Better Auth session, password,
OAuth and database operations. `E2E_MOCK=true` avoids external model work; it
does not replace authentication. No production platform service or real user
credentials are used. This is API/wire validation, not native iOS UI execution.

The checks cover:

- Password registration/login and OIDC linking on 1.6, including both cookies
  and bearer tokens, with the registered `/api/auth/oauth2/callback/platform`
  callback unchanged.
- Existing browser, OIDC and mobile access sessions after upgrade; the old
  password hash still authenticates without being rewritten.
- The iOS contract: no cookies or `Origin` header for redeem/renew, bearer
  session and protected API calls, one-use pairing, rotating refresh secrets,
  immediate invalidation of replaced access, and a stable device id.
- Schema fingerprint, account row ids/provider subjects and password-hash
  continuity through upgrade and rollback. Snapshots contain identifiers and
  digests only, never bearer tokens, cookies or plaintext passwords.
- Rollback acceptance of 1.7-issued browser/OIDC sessions and mobile access and
  refresh credentials, then another upgrade and final logout/device revocation.

An OAuth login started on 1.6 must restart after deployment. In 1.7 the
verification key becomes `auth-state:<state>`, so the old callback returns
`state_mismatch`; its state also lacks the new ID-token nonce. The harness
asserts this rejection and then completes a fresh 1.7 login. Existing completed
sessions are tested independently and must continue to work.

`proof.json` contains the checked versions, every passed assertion, elapsed time
and any failure. Server logs redact generated credentials; metadata snapshots
and logs use owner-only permissions. Child processes and the fresh database are
removed in cleanup unless data retention is explicitly requested. A failed
assertion exits nonzero.
