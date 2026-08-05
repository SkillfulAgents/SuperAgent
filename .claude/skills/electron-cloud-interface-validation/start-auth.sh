#!/bin/zsh
# Start the platform auth issuer (OIDC + the RFC 8693 grant endpoint) on :3002.
#
# Usage:  PLATFORM_WORKTREE=/path/to/platform/worktree ./start-auth.sh
#
# The auth app has no committed .env.local — everything is exported here. The
# Supabase keys are read out of the platform checkout's apps/web/.env.local so
# this stays in step with whatever local Supabase the rest of the stack uses.
set -e

: "${PLATFORM_WORKTREE:?set PLATFORM_WORKTREE to the platform checkout that has apps/auth/src/token/}"
: "${WORKDIR:?set WORKDIR to a scratch dir (holds the signing PEM)}"

WEB_ENV="$PLATFORM_WORKTREE/apps/web/.env.local"
[[ -f "$WEB_ENV" ]] || { echo "missing $WEB_ENV — copy it from the main platform checkout"; exit 1; }

# A stable signing key: the grant assertions the app verifies must be signed by
# the same JWK the issuer advertises. Without a PEM the auth server generates an
# ephemeral key per boot, which breaks verification across restarts.
if [[ ! -f "$WORKDIR/oidc-signing.pem" ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORKDIR/oidc-signing.pem"
  chmod 600 "$WORKDIR/oidc-signing.pem"
  echo "generated $WORKDIR/oidc-signing.pem"
fi

cd "$PLATFORM_WORKTREE/apps/auth"

export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_SERVICE_ROLE_KEY="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$WEB_ENV" | cut -d= -f2-)"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$WEB_ENV" | cut -d= -f2-)"
export AUTH_ISSUER_URL=http://127.0.0.1:3002
export PLATFORM_WEB_ORIGIN=http://127.0.0.1:3000
export AUTH_PUBLIC_HOST=localhost
# MUST be 127.0.0.1: the default `localhost` binds IPv6-only and the app's
# JWKS fetch to 127.0.0.1 then fails.
export AUTH_BIND_HOST=127.0.0.1
export AUTH_PORT=3002
export PLATFORM_OIDC_COOKIE_KEYS=platform-oidc-dev-cookie-key-1,platform-oidc-dev-cookie-key-2
export PLATFORM_OIDC_PRIVATE_KEY_PEM="$(cat "$WORKDIR/oidc-signing.pem")"
# MUST be >= 32 bytes or the ops routes silently disable while the server still
# reports "ready" (look for ops_routes_disabled_bad_token in the log).
export OPS_ADMIN_TOKEN="${OPS_ADMIN_TOKEN:-live-e2e-ops-token-0123456789abcdef0123}"

exec npx tsx src/index.ts
