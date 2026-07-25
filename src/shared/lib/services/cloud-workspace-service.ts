import { captureException } from '@shared/lib/error-reporting'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
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
import { isLocalhostHost, validateMcpDiscoveryUrl } from '@shared/lib/utils/url-safety'

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
}

const NOT_AVAILABLE: CloudWorkspaceStatus = {
  available: false,
  found: false,
  deploymentUrl: null,
  orgId: null,
  hasValidToken: false,
}

// Electron-only: this is a desktop→cloud discovery. A cloud deployment
// discovering itself is meaningless and can create deployment→deployment loops,
// so the whole feature no-ops off the Electron main process.
// (`process.type === 'browser'` is the codebase's Electron-main signal.)
function isElectronMain(): boolean {
  return process.type === 'browser'
}

/**
 * Defense-in-depth before the app POSTs a single-use grant to a platform-
 * supplied URL. The grant's `aud` is bound to `authorization_server`, so:
 *  - `deployment_url` must equal `authorization_server` (else we'd leak a grant
 *    to a host it wasn't minted for), and
 *  - the host must not be a private/loopback SSRF target — resolved via DNS to
 *    also close the rebind axis — and the grant must travel over TLS.
 * Localhost is permitted only under the Electron/E2E exception baked into
 * `validateMcpDiscoveryUrl` (this feature is Electron-only, and local/dev
 * deployments are loopback). Returns false — never throws — so an unsafe or
 * poisoned record simply fails closed to "no workspace".
 */
async function isDeploymentTargetSafe(entry: DeploymentDiscoveryEntry): Promise<boolean> {
  if (entry.deployment_url !== entry.authorization_server) return false
  try {
    const parsed = await validateMcpDiscoveryUrl(entry.deployment_url)
    // Require TLS off-loopback so the grant is never sent in cleartext.
    if (parsed.protocol !== 'https:' && !isLocalhostHost(parsed.hostname)) return false
    return true
  } catch {
    return false
  }
}

function isRecordValidFor(
  record: ReturnType<typeof readCloudWorkspaceRecord>,
  entry: DeploymentDiscoveryEntry,
): boolean {
  if (!record) return false
  // Bind to the exact deployment: a platform-side URL/org change invalidates a
  // token minted for the previous workspace.
  if (record.deploymentUrl !== entry.deployment_url) return false
  if (record.orgId !== entry.org_id) return false
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
  if (isRecordValidFor(readCloudWorkspaceRecord(), entry)) return true

  try {
    const grant = await requestDeploymentGrant(subjectToken, entry.authorization_server)
    const { token, expiresInSec } = await exchangeGrantAtDeployment(entry.deployment_url, grant)
    writeCloudWorkspaceRecord({
      deploymentUrl: entry.deployment_url,
      orgId: entry.org_id,
      token,
      tokenPreview: buildCloudWorkspaceTokenPreview(token),
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
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
 * defensive: any failure degrades to "not found" rather than throwing.
 *
 * Runs the discover → ensure-token algorithm:
 *  1. discover deployments (drives found/not-found)
 *  2. if a deployed workspace exists, ensure a valid deployment token for it
 *  3. otherwise clear any stale stored token
 */
export async function getCloudWorkspace(): Promise<CloudWorkspaceStatus> {
  if (!isElectronMain()) return NOT_AVAILABLE

  const token = getPlatformAccessToken()
  if (!token) {
    clearCloudWorkspaceRecord()
    return { ...NOT_AVAILABLE, available: false }
  }

  let deployments: DeploymentDiscoveryEntry[]
  try {
    deployments = await fetchDeployments(token)
  } catch (error) {
    // Discovery failed (unreachable, or the token isn't member-bound). Keep the
    // section available but empty; don't wipe a still-valid stored token.
    captureException(error, { tags: { area: 'cloud-workspace', op: 'discover' } })
    return { available: true, found: false, deploymentUrl: null, orgId: null, hasValidToken: false }
  }

  const deployed = deployments.find(
    (d) => d.status === DEPLOYED_STATUS && d.deployment_url.length > 0,
  )
  if (!deployed) {
    clearCloudWorkspaceRecord()
    return { available: true, found: false, deploymentUrl: null, orgId: null, hasValidToken: false }
  }

  if (!(await isDeploymentTargetSafe(deployed))) {
    // A mismatched/unsafe deployment URL is a signal, not normal control flow:
    // fail closed (no grant is minted or sent, no workspace surfaced) and flag it.
    captureException(new Error('cloud-workspace: unsafe deployment target'), {
      tags: { area: 'cloud-workspace', op: 'validate-target' },
      extra: {
        deploymentUrl: deployed.deployment_url,
        authorizationServer: deployed.authorization_server,
      },
    })
    clearCloudWorkspaceRecord()
    return { available: true, found: false, deploymentUrl: null, orgId: null, hasValidToken: false }
  }

  const hasValidToken = await ensureDeploymentToken(token, deployed)
  return {
    available: true,
    found: true,
    deploymentUrl: deployed.deployment_url,
    orgId: deployed.org_id,
    hasValidToken,
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
