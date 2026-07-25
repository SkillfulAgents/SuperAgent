import { createHash } from 'node:crypto'

import { captureException } from '@shared/lib/error-reporting'
import {
  getPlatformAccessToken,
  getPlatformAuthStatus,
} from '@shared/lib/services/platform-auth-service'
import {
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

const NOT_AVAILABLE: CloudWorkspaceStatus = {
  available: false,
  found: false,
  deploymentUrl: null,
  orgId: null,
  hasValidToken: false,
  discoveryFailed: false,
}

const NOT_FOUND: CloudWorkspaceStatus = { ...NOT_AVAILABLE, available: true }

const DISCOVERY_FAILED: CloudWorkspaceStatus = { ...NOT_FOUND, discoveryFailed: true }

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
async function isDeploymentTargetSafe(entry: DeploymentDiscoveryEntry): Promise<boolean> {
  if (entry.deployment_url !== entry.authorization_server) return false
  const policy = deploymentHostPolicy()
  try {
    const parsed = await validateMcpDiscoveryUrl(entry.deployment_url, policy)
    // Require TLS off-loopback so the grant is never sent in cleartext.
    if (parsed.protocol !== 'https:' && !isLocalhostHost(parsed.hostname)) return false
    return true
  } catch {
    return false
  }
}

/**
 * The account a deployment token belongs to. Read live (not cached) so it
 * reflects a disconnect that happened while a refresh was in flight.
 *
 * `userId`/`memberId` alone are not enough to identify an account: a connection
 * whose introspection never filled them in carries nulls, and so does a
 * *disconnected* app. Comparing those would make two different accounts — or an
 * account and no account at all — look identical. So the principal also carries
 * `connected` and a fingerprint of the platform credential itself, which is
 * always present on a live connection and always differs between accounts.
 */
interface CloudWorkspacePrincipal {
  connected: boolean
  userId: string | null
  memberId: string | null
  /** Stable, non-reversible id for the platform credential in hand. */
  tokenFingerprint: string | null
}

const NO_PRINCIPAL: CloudWorkspacePrincipal = {
  connected: false,
  userId: null,
  memberId: null,
  tokenFingerprint: null,
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}

function readPrincipal(): CloudWorkspacePrincipal {
  const status = getPlatformAuthStatus()
  const token = getPlatformAccessToken()
  if (!status.connected || !token) return NO_PRINCIPAL
  return {
    connected: true,
    userId: status.userId ?? null,
    memberId: status.memberId ?? null,
    tokenFingerprint: fingerprintToken(token),
  }
}

/**
 * True only for two *known, live* principals that are the same account. An
 * unidentifiable principal (disconnected, or no credential to fingerprint) is
 * never equal to anything — including another unidentifiable one, which is what
 * would otherwise let a token leak across accounts or survive a disconnect.
 */
function samePrincipal(a: CloudWorkspacePrincipal, b: CloudWorkspacePrincipal): boolean {
  if (!a.connected || !b.connected) return false
  if (!a.tokenFingerprint || !b.tokenFingerprint) return false
  return (
    a.tokenFingerprint === b.tokenFingerprint &&
    a.userId === b.userId &&
    a.memberId === b.memberId
  )
}

function isRecordValidFor(
  record: ReturnType<typeof readCloudWorkspaceRecord>,
  entry: DeploymentDiscoveryEntry,
  principal: CloudWorkspacePrincipal,
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
  const recordPrincipal: CloudWorkspacePrincipal = {
    connected: Boolean(record.tokenFingerprint),
    userId: record.userId,
    memberId: record.memberId,
    tokenFingerprint: record.tokenFingerprint,
  }
  if (!samePrincipal(recordPrincipal, principal)) return false
  const expiresAtMs = Date.parse(record.expiresAt)
  if (Number.isNaN(expiresAtMs)) return false
  return expiresAtMs - Date.now() > REFRESH_BUFFER_MS
}

/**
 * Ensure a valid deployment token is held for `entry`, minting a fresh grant +
 * exchanging it only when the stored token is missing, bound to a different
 * deployment, or within the refresh buffer of expiry. Returns whether a valid
 * token is held afterward. Never throws — failures are reported and swallowed.
 */
async function ensureDeploymentToken(
  subjectToken: string,
  entry: DeploymentDiscoveryEntry,
): Promise<boolean> {
  const principal = readPrincipal()
  if (isRecordValidFor(readCloudWorkspaceRecord(), entry, principal)) return true
  // Nothing to attribute a new token to — don't mint one we couldn't safely
  // reuse anyway. (Unreachable via getCloudWorkspace, which needs a token to get
  // this far; belt-and-braces for any other caller.)
  if (!principal.connected) return false

  try {
    const grant = await requestDeploymentGrant(subjectToken, entry.authorization_server)
    const { token, expiresInSec } = await exchangeGrantAtDeployment(
      entry.deployment_url,
      grant,
      deploymentHostPolicy(),
    )
    // The account can be disconnected or switched while the grant round-trip is
    // in flight, after the clear-on-identity-change has already run. Re-read the
    // principal here — the check and the (synchronous) write can't be
    // interleaved — so a stale refresh can never resurrect the old user's token.
    if (!samePrincipal(principal, readPrincipal())) return false
    writeCloudWorkspaceRecord({
      deploymentUrl: entry.deployment_url,
      orgId: entry.org_id,
      token,
      tokenPreview: buildCloudWorkspaceTokenPreview(token),
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      userId: principal.userId,
      memberId: principal.memberId,
      tokenFingerprint: principal.tokenFingerprint,
    })
    return true
  } catch (error) {
    // Grant/exchange failure (e.g. a deployment without the exchange endpoint)
    // is non-fatal: the workspace still shows, just without a maintained token.
    captureException(error, { tags: { area: 'cloud-workspace', op: 'ensure-token' } })
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
 */
export async function getCloudWorkspace(): Promise<CloudWorkspaceStatus> {
  if (!isElectronMain()) return NOT_AVAILABLE

  const token = getPlatformAccessToken()
  if (!token) {
    clearCloudWorkspaceRecord()
    return NOT_AVAILABLE
  }

  let deployments: DeploymentDiscoveryEntry[]
  try {
    deployments = await fetchDeployments(token)
  } catch (error) {
    // Unreachable platform, 401, malformed body — we don't know whether a
    // workspace exists. Report it as such (the card offers a retry rather than
    // "create one"), and don't wipe a still-valid stored token.
    captureException(error, { tags: { area: 'cloud-workspace', op: 'discover' } })
    return DISCOVERY_FAILED
  }

  const deployed = deployments.find(
    (d) => d.status === DEPLOYED_STATUS && d.deployment_url.length > 0,
  )
  if (!deployed) {
    clearCloudWorkspaceRecord()
    return NOT_FOUND
  }

  if (!(await isDeploymentTargetSafe(deployed))) {
    // A mismatched/unsafe deployment URL is a signal, not normal control flow:
    // fail closed (no grant is minted or sent, no workspace surfaced) and flag
    // it. Reported as a failure, not as absence — the workspace does exist, we
    // just refuse to talk to the address we were handed.
    captureException(new Error('cloud-workspace: unsafe deployment target'), {
      tags: { area: 'cloud-workspace', op: 'validate-target' },
      extra: {
        deploymentUrl: deployed.deployment_url,
        authorizationServer: deployed.authorization_server,
      },
    })
    clearCloudWorkspaceRecord()
    return DISCOVERY_FAILED
  }

  const hasValidToken = await ensureDeploymentToken(token, deployed)
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
    captureException(error, { tags: { area: 'cloud-workspace', op: 'refresh' } })
  }
}
