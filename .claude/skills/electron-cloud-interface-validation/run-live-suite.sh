#!/bin/zsh
# Run the gated live suite against a stack that is already up.
#
# Usage:  WORKDIR=/tmp/cloud-live ./run-live-suite.sh [extra vitest args]
#
# Values match seed.sql. LIVE_ORG_RUNTIME_TOKEN is optional but worth passing —
# without it the org-runtime rejection check silently returns early instead of
# asserting anything. node3.env's PLATFORM_TOKEN *is* an org-runtime JWT, so it
# doubles as that fixture.
set -e

: "${WORKDIR:?set WORKDIR to the scratch dir holding node3.env}"
APP_ROOT="${APP_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"

ORG_JWT="$(grep '^PLATFORM_TOKEN=' "$WORKDIR/node3.env" 2>/dev/null | cut -d= -f2- || true)"

cd "$APP_ROOT"
LIVE_E2E=1 \
LIVE_PLATFORM_TOKEN=plat_sa_e2e_deadbeefdeadbeefdeadbeefdeadbeef \
LIVE_PROXY_URL=http://127.0.0.1:8787 \
LIVE_AUTH_ISSUER_URL=http://127.0.0.1:3002 \
LIVE_DEPLOYMENT_URL=http://127.0.0.1:8899 \
LIVE_ORG_ID=org_11111111-1111-1111-1111-111111111111 \
LIVE_EMAIL=e2e-owner@test.io \
LIVE_ORG_RUNTIME_TOKEN="$ORG_JWT" \
npx vitest run --reporter=verbose \
  src/shared/lib/services/cloud-workspace-service.live.test.ts "$@"
