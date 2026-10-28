/**
 * Coordinates of the local three-node stack this harness drives.
 *
 * Defaults match the runbook in
 * `.claude/skills/electron-cloud-interface-validation/SKILL.md`; every value can
 * be overridden from the environment so the harness can point at a stack raised
 * on different ports.
 */

export const STACK = {
  /** Platform auth issuer: OIDC + the RFC 8693 grant endpoint. */
  authIssuerUrl: process.env.LIVE_AUTH_ISSUER_URL ?? 'http://127.0.0.1:3002',
  /** Platform proxy: `GET /v1/me/deployments` (discovery). */
  proxyUrl: process.env.LIVE_PROXY_URL ?? 'http://127.0.0.1:8787',
  /** Node 3 — an auth-mode deployment of this same app, playing "cloud workspace". */
  deploymentUrl: process.env.LIVE_DEPLOYMENT_URL ?? 'http://127.0.0.1:8899',

  /** The seeded member-bound access key the desktop app authenticates with. */
  platformToken:
    process.env.LIVE_PLATFORM_TOKEN ?? 'plat_sa_e2e_deadbeefdeadbeefdeadbeefdeadbeef',
  orgId: process.env.LIVE_ORG_ID ?? 'org_11111111-1111-1111-1111-111111111111',
  orgName: 'E2E Org',
  email: process.env.LIVE_EMAIL ?? 'e2e-owner@test.io',
}

/**
 * A CDP port for the Electron instance under test.
 *
 * Deliberately not 9222: that is the default every other Chromium on the machine
 * reaches for, and attaching to somebody else's browser would drive the wrong
 * application while reporting success.
 */
export const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9411)
