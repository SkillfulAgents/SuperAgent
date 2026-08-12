import { createHash } from 'node:crypto'

import { captureException } from '@shared/lib/error-reporting'
import {
  getPlatformAccessToken,
  getPlatformAuthStatus,
} from '@shared/lib/services/platform-auth-service'
import {
  CloudWorkspaceError,
  exchangeGrantAtDeployment,
  fetchDeployments,
  requestDeploymentGrant,
} from '@shared/lib/platform-auth/cloud-workspace-client'
import {
  buildCloudWorkspaceTokenPreview,
  clearCloudWorkspaceRecord,
  readCloudWorkspaceRecord,
  writeCloudWorkspaceRecord,
} from '@shared/lib/platform-auth/cloud-workspace-record'
import {
  DEPLOYED_STATUS,
  type DeploymentDiscoveryEntry,
} from '@shared/lib/platform-auth/cloud-workspace-schema'
import {
  isLocalhostHost,
  validateMcpDiscoveryUrl,
  type DiscoveryHostPolicy,
} from '@shared/lib/utils/url-safety'

// Re-mint the deployment token once it's within this window of expiry, so we
// keep a valid token in hand rather than waiting to be caught expired.
const REFRESH_BUFFER_MS = 60 * 60 * 1000 // 1 hour

/**
 * Cloud-workspace status surfaced to the Account tab. `found`/`deploymentUrl`
 * are driven purely by discovery — decoupled from whether the deployment token
 * exchange succeeded (that's background infra, and older deployments may not
 * support it yet). `hasValidToken` is diagnostic only.
 */
export interface CloudWorkspaceStatus {
  /** Running under Electron with a connected, member-bound platform account. */
  available: boolean
  /** A deployed cloud workspace exists for the account. */
  found: boolean
  deploymentUrl: string | null
  orgId: string | null
  /** Whether a live deployment token is held (infra/diagnostic). */
  hasValidToken: boolean
  /**
   * Discovery itself failed (unreachable platform, 401, malformed response), so
   * `found: false` means "unknown", NOT "confirmed absent". Kept distinct so the
   * UI offers a retry instead of telling the user to create a workspace they
   * may well already have.
   */
  discoveryFailed: boolean
}

// Frozen: these are returned directly to callers, so they must not become a
// shared mutable object a consumer can scribble on.
const NOT_AVAILABLE: CloudWorkspaceStatus = Object.freeze({
  available: false,
  found: false,
  deploymentUrl: null,
  orgId: null,
  hasValidToken: false,
  discoveryFailed: false,
})

const NOT_FOUND: CloudWorkspaceStatus = Object.freeze({ ...NOT_AVAILABLE, available: true })

const DISCOVERY_FAILED: CloudWorkspaceStatus = Object.freeze({
  ...NOT_FOUND,
  discoveryFailed: true,
})

/**
 * Report a maintenance failure once per process per distinct cause.
 *
 * Everything here runs on a 30-minute poll, and the conditions that break it are
 * typically persistent — offline, a token that isn't member-bound, a deployment
 * too old to have the exchange endpoint. Capturing on every cycle would turn one
 * broken install into a steady stream of identical Sentry events. The `cause`
 * chain on {@link CloudWorkspaceError} carries the root error, so one report
 * still has the detail.
 */
const reportedFailures = new Set<string>()

function reportFailureOnce(
  op: string,
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  const status = error instanceof CloudWorkspaceError ? error.status : undefined
  const key = `${op}:${status ?? (error instanceof Error ? error.message : 'unknown')}`
  if (reportedFailures.has(key)) return
  reportedFailures.add(key)
  captureException(error, { tags: { area: 'cloud-workspace', op }, extra })
}

/** Test seam: the once-per-process guard would otherwise leak between cases. */
export function _resetCloudWorkspaceFailureReportingForTest(): void {
  reportedFailures.clear()
}

// Electron-only: this is a desktop→cloud discovery. A cloud deployment
// discovering itself is meaningless and can create deployment→deployment loops,
// so the whole feature no-ops off the Electron main process.
// (`process.type === 'browser'` is the codebase's Electron-main signal.)
function isElectronMain(): boolean {
  return process.type === 'browser'
}

/**
 * Whether a loopback deployment target may be trusted.
 *
 * The default localhost exception in `url-safety` opens up for *any* Electron
 * main process — right for user-configured local MCP servers, wrong here: the
 * deployment URL comes off the wire, so in a shipped build a hostile discovery
 * response could aim the grant at the user's own loopback interface. Loopback
 * is therefore accepted only when we're demonstrably running a local stack:
 * an unpackaged (dev) Electron main, or an E2E run.
 *
 * `SUPERAGENT_IS_PACKAGED` is published from `app.isPackaged` by the Electron
 * main entry on every launch (shared code can't import electron), so a shipped
 * build always overwrites an inherited value. Anything other than an explicit
 * '0' — including unset — counts as packaged, so this fails closed.
 */
function deploymentHostPolicy(): DiscoveryHostPolicy {
  // Both are exact-value checks: env vars are strings, so a presence test would
  // also open this up for `SUPERAGENT_IS_PACKAGED=1` … or `E2E_MOCK=false`.
  const unpackaged = process.env.SUPERAGENT_IS_PACKAGED === '0'
  return { allowLocalhost: unpackaged || process.env.E2E_MOCK === 'true' }
}

/**
 * Scheme/host check for a deployment URL we are about to send a credential to.
 *
 * This is the *synchronous* half of the gate below, split out so per-request
 * consumers (the cloud proxy) can re-check the target they read back from
 * settings without paying for a DNS lookup on every call. It deliberately does
 * NOT re-run the DNS-resolved private-range policy: that closes the rebind axis
 * on a URL freshly off the wire, which is a mint-time concern. What it does
 * enforce is the part that must hold on every single request — the bearer never
 * travels in cleartext, and a shipped build never talks to loopback.
 */
export function isDeploymentUrlAllowed(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (isLocalhostHost(parsed.hostname)) return deploymentHostPolicy().allowLocalhost === true
  return parsed.protocol === 'https:'
}

/**
 * Defense-in-depth before the app POSTs a single-use grant to a platform-
 * supplied URL. The grant's `aud` is bound to `authorization_server`, so:
 *  - `deployment_url` must equal `authorization_server` (else we'd leak a grant
 *    to a host it wasn't minted for), and
 *  - the host must not be a private/loopback SSRF target — resolved via DNS to
 *    also close the rebind axis — and the grant must travel over TLS.
 * Loopback is allowed only per `deploymentHostPolicy()` (never in a shipped
 * build). Returns false — never throws — so an unsafe or poisoned record simply
 * fails closed to "no workspace".
 */
type DeploymentSafetyReason = 'url-mismatch' | 'invalid-url' | 'private-dns' | 'cleartext' | 'safe'

async function deploymentTargetSafety(entry: DeploymentDiscoveryEntry): Promise<DeploymentSafetyReason> {
  if (entry.deployment_url !== entry.authorization_server) return 'url-mismatch'
  const policy = deploymentHostPolicy()
  try {
    const parsed = await validateMcpDiscoveryUrl(entry.deployment_url, policy)
    // Require TLS off-loopback so the grant is never sent in cleartext.
    if (parsed.protocol !== 'https:' && !isLocalhostHost(parsed.hostname)) return 'cleartext'
    return 'safe'
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    return /private|loopback|link-local|dns/.test(message) ? 'private-dns' : 'invalid-url'
  }
}

/**
 * The acting platform account, captured as one consistent snapshot: the bearer
 * we present, the identity we'd attribute a session to, and the org we act as
 * must all come from the same read. Reading them at different points across an
 * await is how account A's token ends up minting a session recorded under
 * account B.
 *
 * `userId`/`memberId` alone are not enough to identify an account: a connection
 * whose introspection never filled them in carries nulls, and so does a
 * *disconnected* app. Comparing those would make two different accounts — or an
 * account and no account at all — look identical. So the snapshot also carries
 * `connected` and a fingerprint of the credential itself, which is always
 * present on a live connection and always differs between accounts.
 */
interface CloudWorkspaceAccount {
  connected: boolean
  userId: string | null
  memberId: string | null
  /** Org we are acting as — discovery answers for the user, across all orgs. */
  orgId: string | null
  /** Stable, non-reversible id for the platform credential in hand. */
  tokenFingerprint: string | null
  /** The bearer to present. In-memory only; never persisted. */
  token: string | null
}

const NO_ACCOUNT: CloudWorkspaceAccount = {
  connected: false,
  userId: null,
  memberId: null,
  orgId: null,
  tokenFingerprint: null,
  token: null,
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}

function readAccount(): CloudWorkspaceAccount {
  const status = getPlatformAuthStatus()
  const token = getPlatformAccessToken()
  if (!status.connected || !token) return NO_ACCOUNT
  return {
    connected: true,
    userId: status.userId ?? null,
    memberId: status.memberId ?? null,
    orgId: status.orgId ?? null,
    tokenFingerprint: fingerprintToken(token),
    token,
  }
}

/**
 * True only for two *known, live* snapshots of the same account. An
 * unidentifiable one (disconnected, or no credential to fingerprint) is never
 * equal to anything — including another unidentifiable one, which is what would
 * otherwise let a token leak across accounts or survive a disconnect.
 */
function sameAccount(a: CloudWorkspaceAccount, b: CloudWorkspaceAccount): boolean {
  if (!a.connected || !b.connected) return false
  if (!a.tokenFingerprint || !b.tokenFingerprint) return false
  return (
    a.tokenFingerprint === b.tokenFingerprint &&
    a.userId === b.userId &&
    a.memberId === b.memberId &&
    a.orgId === b.orgId
  )
}

function isRecordValidFor(
  record: ReturnType<typeof readCloudWorkspaceRecord>,
  entry: DeploymentDiscoveryEntry,
  account: CloudWorkspaceAccount,
): boolean {
  if (!record) return false
  // Bind to the exact deployment: a platform-side URL/org change invalidates a
  // token minted for the previous workspace.
  if (record.deploymentUrl !== entry.deployment_url) return false
  if (record.orgId !== entry.org_id) return false
  // …and to the acting account: the token is a session for one specific user on
  // that deployment, never reusable by another. A record with no fingerprint
  // (written before this binding existed) is not attributable to anyone, so it
  // is re-minted rather than trusted.
  const recordAccount: CloudWorkspaceAccount = {
    connected: Boolean(record.tokenFingerprint),
    userId: record.userId,
    memberId: record.memberId,
    orgId: record.orgId,
    tokenFingerprint: record.tokenFingerprint,
    token: null,
  }
  if (!sameAccount(recordAccount, account)) return false
  const expiresAtMs = Date.parse(record.expiresAt)
  if (Number.isNaN(expiresAtMs)) return false
  return expiresAtMs - Date.now() > REFRESH_BUFFER_MS
}

/**
 * Ensure a valid deployment token is held for `entry`, minting a fresh grant +
 * exchanging it only when the stored token is missing, bound to a different
 * deployment, or within the refresh buffer of expiry. Returns whether a valid
 * token is held afterward. Never throws — failures are reported and swallowed.
 *
 * `forceRefresh` mints unconditionally. It exists for the case the expiry clock
 * cannot see: a token the deployment has already rejected (revoked session,
 * server-side eviction, a clock skew that makes a dead token look live). The
 * stored record is left untouched until the replacement is in hand, so a failed
 * re-mint degrades to "the token we had" rather than to nothing.
 */
async function ensureDeploymentToken(
  account: CloudWorkspaceAccount,
  entry: DeploymentDiscoveryEntry,
  forceRefresh = false,
): Promise<boolean> {
  if (!forceRefresh && isRecordValidFor(readCloudWorkspaceRecord(), entry, account)) return true
  // Nothing to attribute a new token to — don't mint one we couldn't safely
  // reuse anyway. (Unreachable via getCloudWorkspace, which snapshots a
  // connected account to get this far; belt-and-braces for any other caller.)
  if (!account.connected || !account.token) return false

  try {
    const grant = await requestDeploymentGrant(account.token, entry.authorization_server)
    const { token, expiresInSec } = await exchangeGrantAtDeployment(
      entry.deployment_url,
      grant,
      deploymentHostPolicy(),
    )
    // The account can be disconnected or switched while the grant round-trip is
    // in flight, after the clear-on-identity-change has already run. Re-read it
    // here — the check and the (synchronous) write can't be interleaved — so a
    // stale refresh can never resurrect the old account's token.
    if (!sameAccount(account, readAccount())) return false
    writeCloudWorkspaceRecord({
      deploymentUrl: entry.deployment_url,
      orgId: entry.org_id,
      token,
      tokenPreview: buildCloudWorkspaceTokenPreview(token),
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      userId: account.userId,
      memberId: account.memberId,
      tokenFingerprint: account.tokenFingerprint,
    })
    return true
  } catch (error) {
    // Grant/exchange failure (e.g. a deployment without the exchange endpoint)
    // is non-fatal: the workspace still shows, just without a maintained token.
    reportFailureOnce('ensure-token', error)
    return false
  }
}

/**
 * Resolve the cloud-workspace status and maintain the deployment token. Fully
 * defensive: any failure degrades rather than throwing.
 *
 * Runs the discover → ensure-token algorithm:
 *  1. discover deployments (drives found/not-found)
 *  2. if a deployed workspace exists, ensure a valid deployment token for it
 *  3. otherwise clear any stale stored token
 *
 * Note the difference between the two "no workspace" outcomes: a *successful*
 * discovery that lists none is `found: false`, while a discovery that failed is
 * additionally `discoveryFailed: true` — absence we couldn't confirm.
 *
 * `forceTokenRefresh` re-mints even when the stored token still looks live —
 * see {@link ensureDeploymentToken}. Everything else about the cycle (discovery,
 * org filtering, the SSRF gate) runs exactly as normal, so a forced refresh can
 * never reach a target the ordinary path wouldn't.
 */
export async function getCloudWorkspace(
  options: { forceTokenRefresh?: boolean } = {},
): Promise<CloudWorkspaceStatus> {
  if (!isElectronMain()) return NOT_AVAILABLE

  // One snapshot drives the whole cycle: the bearer we present, the org we
  // filter by, and the identity we'd record must all be the same account.
  const account = readAccount()
  if (!account.connected || !account.token) {
    clearCloudWorkspaceRecord()
    return NOT_AVAILABLE
  }

  let deployments: DeploymentDiscoveryEntry[]
  try {
    deployments = await fetchDeployments(account.token)
  } catch (error) {
    // Unreachable platform, 401, malformed body — we don't know whether a
    // workspace exists. Report it as such (the card offers a retry rather than
    // "create one"), and don't wipe a still-valid stored token.
    reportFailureOnce('discover', error)
    return DISCOVERY_FAILED
  }

  // The account can be swapped while discovery is in flight, and this answer
  // belongs to whoever we asked as — not to whoever is connected now. Acting on
  // it would clear the new account's record, or mint from the old account's
  // bearer and file the result under the new account's identity. Abandon the
  // cycle instead: touch nothing, report "unknown", and let the refresh that the
  // identity change itself triggers produce the real answer.
  if (!sameAccount(account, readAccount())) return DISCOVERY_FAILED

  // `/v1/me/deployments` answers for the *user*, who may belong to several orgs.
  // Only the org we're acting as is ours to show or mint against — another org's
  // workspace would render an "Open" link the account can't use and a grant the
  // platform would refuse. Unknown org ⇒ don't filter.
  const deployed = deployments.find(
    (d) =>
      d.status === DEPLOYED_STATUS &&
      d.deployment_url.length > 0 &&
      (!account.orgId || d.org_id === account.orgId),
  )
  if (!deployed) {
    clearCloudWorkspaceRecord()
    return NOT_FOUND
  }

  const safetyReason = await deploymentTargetSafety(deployed)
  if (safetyReason !== 'safe') {
    // A mismatched/unsafe deployment URL is a signal, not normal control flow:
    // fail closed (no grant is minted or sent, no workspace surfaced) and flag
    // it. Report only the categorical reason: target/auth URLs and DNS answers
    // are credentials-adjacent deployment data and must not enter telemetry.
    reportFailureOnce('validate-target', new Error('cloud-workspace: unsafe deployment target'), {
      safetyReason,
    })
    clearCloudWorkspaceRecord()
    return DISCOVERY_FAILED
  }

  const hasValidToken = await ensureDeploymentToken(
    account,
    deployed,
    options.forceTokenRefresh,
  )
  return {
    available: true,
    found: true,
    deploymentUrl: deployed.deployment_url,
    orgId: deployed.org_id,
    hasValidToken,
    discoveryFailed: false,
  }
}

/**
 * Boot/connect hook: run the discover → ensure-token cycle so the deployment
 * token is maintained even when the Account tab is never opened. Never throws.
 */
export async function refreshCloudWorkspace(): Promise<void> {
  try {
    await getCloudWorkspace()
  } catch (error) {
    reportFailureOnce('refresh', error)
  }
}
