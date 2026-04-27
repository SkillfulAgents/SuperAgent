import { getSettings, updateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { PlatformAuthSettingsSchema } from '@shared/lib/types/skillset-schema'
import { captureException } from '@shared/lib/error-reporting'
import { isAuthMode } from '@shared/lib/auth/mode'

export type PlatformAuthRecord = PlatformAuthSettings

// `env` means AUTH_MODE is using an org-managed PLATFORM_TOKEN.
export type PlatformAuthSource = 'settings' | 'env' | null

export interface PlatformAuthStatus {
  connected: boolean
  tokenPreview: string | null
  email: string | null
  label: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  createdAt: string | null
  updatedAt: string | null
  source: PlatformAuthSource
}

interface SavePlatformAuthInput {
  token: string
  email?: string | null
  label?: string | null
  orgId?: string | null
  orgName?: string | null
  role?: string | null
}

function buildTokenPreview(token: string): string {
  if (token.length <= 12) {
    return token
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}

function readRecord(): PlatformAuthRecord | null {
  const raw = getSettings().platformAuth
  if (!raw) return null
  // Validate at the boundary; a corrupt settings.json shouldn't crash callers
  // mid-request, but we do want to see it in Sentry.
  const parsed = PlatformAuthSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: 'platform-auth', op: 'read' } })
    return null
  }
  return parsed.data
}

function writeRecord(record: PlatformAuthRecord | null): void {
  const settings = getSettings()
  settings.platformAuth = record ?? undefined
  updateSettings(settings)
}

/**
 * Reconcile skillset configs + installed metadata after an auth change.
 *
 * Provider-polymorphic: each provider's `isConfigValid` / `isInstalledValid`
 * decides what belongs. Lives behind a dynamic import to break a module
 * cycle (skillset-reconcile → skillset-provider → platform-provider → here).
 */
async function reconcileAfterAuthChange(): Promise<void> {
  try {
    const mod = await import('./skillset-reconcile')
    mod.reconcileSkillsetConfigsForCurrentAuth()
    await mod.reconcileInstalledForCurrentAuth()
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'reconcile' } })
  }
}

// Best-effort decode for the orgId claim used by env-managed UI.
function decodeOrgIdFromToken(token: string): string | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  try {
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { orgId?: unknown }
    return typeof parsed.orgId === 'string' && parsed.orgId.length > 0 ? parsed.orgId : null
  } catch {
    return null
  }
}

function getEnvManagedStatus(): PlatformAuthStatus | null {
  if (!isAuthMode()) return null
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  if (!envToken) return null

  return {
    connected: true,
    tokenPreview: buildTokenPreview(envToken),
    email: null,
    label: 'Managed by organization',
    orgId: decodeOrgIdFromToken(envToken),
    orgName: null,
    role: null,
    createdAt: null,
    updatedAt: null,
    source: 'env',
  }
}

export function getPlatformAuthStatus(_userId?: string): PlatformAuthStatus {
  const record = readRecord()
  if (record) {
    return {
      connected: true,
      tokenPreview: record.tokenPreview,
      email: record.email,
      label: record.label,
      orgId: record.orgId,
      orgName: record.orgName,
      role: record.role,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      source: 'settings',
    }
  }

  const envManaged = getEnvManagedStatus()
  if (envManaged) return envManaged

  return {
    connected: false,
    tokenPreview: null,
    email: null,
    label: null,
    orgId: null,
    orgName: null,
    role: null,
    createdAt: null,
    updatedAt: null,
    source: null,
  }
}

export async function savePlatformAuth(_userId: string, input: SavePlatformAuthInput): Promise<PlatformAuthStatus> {
  const trimmedToken = input.token.trim()
  if (!trimmedToken) {
    throw new Error('Token is required')
  }

  const existing = readRecord()
  const newOrgId = input.orgId?.trim() || null
  const orgChanged = existing?.orgId !== newOrgId

  const now = new Date().toISOString()
  const record: PlatformAuthRecord = PlatformAuthSettingsSchema.parse({
    token: trimmedToken,
    tokenPreview: buildTokenPreview(trimmedToken),
    email: input.email?.trim() || null,
    label: input.label?.trim() || null,
    orgId: newOrgId,
    orgName: input.orgName?.trim() || null,
    role: input.role?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  writeRecord(record)

  if (orgChanged) {
    // Auth state changed — sweep stale configs + installed files for the
    // previous org. Runs *after* writing the new record so the polymorphic
    // reconcile sees the current auth.
    await reconcileAfterAuthChange()
  }

  return getPlatformAuthStatus()
}

export function getPlatformAccessToken(_userId?: string): string | null {
  const stored = readRecord()?.token
  if (stored) return stored
  if (!isAuthMode()) return null
  const envToken = process.env.PLATFORM_TOKEN?.trim()
  return envToken ? envToken : null
}

// Build a composite bearer `<token>:<memberId>` that the proxy can split.
// Falls back to raw token when memberId is unavailable.
export function getPlatformBearerWithMember(memberId: string | null): string | null {
  const token = getPlatformAccessToken()
  if (!token) return null
  return memberId ? `${token}:${memberId}` : token
}

async function clearPlatformAuth(): Promise<void> {
  writeRecord(null)
  await reconcileAfterAuthChange()
}

export async function revokePlatformTokenRemotely(): Promise<boolean> {
  const token = readRecord()?.token
  if (!token) return false

  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) return false

  try {
    const res = await fetch(`${proxyBase}/v1/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    return res.ok
  } catch (error) {
    captureException(error, { tags: { area: 'platform-auth', op: 'revoke' } })
    return false
  }
}

export async function revokePlatformToken(options?: { clearLocal?: boolean }): Promise<boolean> {
  const success = await revokePlatformTokenRemotely()
  if (options?.clearLocal !== false) {
    await clearPlatformAuth()
  }
  return success
}
