import { getSettings, updateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'

export type PlatformAuthRecord = PlatformAuthSettings

export interface PlatformAuthStatus {
  connected: boolean
  tokenPreview: string | null
  email: string | null
  label: string | null
  orgName: string | null
  role: string | null
  createdAt: string | null
  updatedAt: string | null
}

interface SavePlatformAuthInput {
  token: string
  email?: string | null
  label?: string | null
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
  return getSettings().platformAuth ?? null
}

function writeRecord(record: PlatformAuthRecord | null): void {
  const settings = getSettings()
  settings.platformAuth = record ?? undefined
  updateSettings(settings)
}

export function getPlatformAuthStatus(_userId?: string): PlatformAuthStatus {
  const record = readRecord()
  if (!record) {
    return {
      connected: false,
      tokenPreview: null,
      email: null,
      label: null,
      orgName: null,
      role: null,
      createdAt: null,
      updatedAt: null,
    }
  }

  return {
    connected: true,
    tokenPreview: record.tokenPreview,
    email: record.email,
    label: record.label,
    orgName: record.orgName,
    role: record.role,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function savePlatformAuth(_userId: string, input: SavePlatformAuthInput): PlatformAuthStatus {
  const trimmedToken = input.token.trim()
  if (!trimmedToken) {
    throw new Error('Token is required')
  }

  const existing = readRecord()
  const now = new Date().toISOString()
  const record: PlatformAuthRecord = {
    token: trimmedToken,
    tokenPreview: buildTokenPreview(trimmedToken),
    email: input.email?.trim() || null,
    label: input.label?.trim() || null,
    orgName: input.orgName?.trim() || null,
    role: input.role?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  writeRecord(record)
  return getPlatformAuthStatus()
}

export function getPlatformAccessToken(_userId?: string): string | null {
  return readRecord()?.token ?? null
}

function clearPlatformAuth(): void {
  writeRecord(null)
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
  } catch {
    return false
  }
}

export async function revokePlatformToken(options?: { clearLocal?: boolean }): Promise<boolean> {
  const success = await revokePlatformTokenRemotely()
  if (options?.clearLocal !== false) {
    clearPlatformAuth()
  }
  return success
}

