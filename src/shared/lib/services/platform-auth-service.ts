import fs from 'fs'
import path from 'path'
import { getSettings, updateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getAgentsDir, getAgentWorkspaceDir, readFileOrNull } from '@shared/lib/utils/file-storage'

export type PlatformAuthRecord = PlatformAuthSettings

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
  return getSettings().platformAuth ?? null
}

function writeRecord(record: PlatformAuthRecord | null): void {
  const settings = getSettings()
  settings.platformAuth = record ?? undefined
  updateSettings(settings)
}

/**
 * Remove platform skillsets from settings.
 * If orgId is provided, only removes skillsets belonging to that org.
 * If orgId is omitted, removes all platform skillsets (used on full disconnect).
 */
function removePlatformSkillsets(orgId?: string): void {
  const settings = getSettings()
  const before = settings.skillsets?.length ?? 0
  settings.skillsets = (settings.skillsets || []).filter((s) => {
    if (s.provider !== 'platform') return true
    if (!orgId) return false
    const ssOrgId = (s.providerData as Record<string, unknown> | undefined)?.orgId as string | undefined
    return ssOrgId !== orgId
  })
  if (settings.skillsets.length !== before) {
    updateSettings(settings)
  }
}

/**
 * Ensure platform skillsets in settings belong to the currently connected org.
 * Removes any that don't match (including legacy entries with no orgId). Call on startup.
 */
export async function reconcilePlatformSkillsets(): Promise<void> {
  const record = readRecord()
  if (!record || !record.orgId) {
    removePlatformSkillsets()
    await removePlatformSkillFiles()
    return
  }
  const currentOrgId = record.orgId
  const settings = getSettings()
  const before = settings.skillsets?.length ?? 0
  settings.skillsets = (settings.skillsets || []).filter((s) => {
    if (s.provider !== 'platform') return true
    const ssOrgId = (s.providerData as Record<string, unknown> | undefined)?.orgId as string | undefined
    return ssOrgId === currentOrgId
  })
  if (settings.skillsets.length !== before) {
    updateSettings(settings)
  }
  await removePlatformSkillFiles(currentOrgId)
}

/**
 * Remove installed skill directories and agent template metadata that belong to
 * platform skillsets no longer in the current org. If keepOrgId is provided,
 * skills from that org are kept; otherwise all platform-origin skills are removed.
 */
async function removePlatformSkillFiles(keepOrgId?: string): Promise<void> {
  const agentsRoot = getAgentsDir()
  let agentDirs: fs.Dirent[]
  try {
    agentDirs = await fs.promises.readdir(agentsRoot, { withFileTypes: true })
  } catch {
    return
  }

  for (const agentEntry of agentDirs) {
    if (!agentEntry.isDirectory()) continue
    const slug = agentEntry.name

    // --- Installed skills ---
    const skillsDir = path.join(getAgentWorkspaceDir(slug), '.claude', 'skills')
    let skillDirs: fs.Dirent[]
    try {
      skillDirs = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    } catch {
      skillDirs = []
    }

    for (const skillEntry of skillDirs) {
      if (!skillEntry.isDirectory()) continue
      const metaPath = path.join(skillsDir, skillEntry.name, '.skillset-metadata.json')
      const raw = await readFileOrNull(metaPath)
      if (!raw) continue
      try {
        const meta = JSON.parse(raw)
        if (meta.provider !== 'platform') continue
        const ssOrgId = (meta.providerData as Record<string, unknown> | undefined)?.orgId as string | undefined
        if (keepOrgId && ssOrgId === keepOrgId) continue
        await fs.promises.rm(path.join(skillsDir, skillEntry.name), { recursive: true, force: true })
      } catch { /* skip unparseable */ }
    }

    // --- Agent template metadata ---
    const templateMetaPath = path.join(getAgentWorkspaceDir(slug), '.skillset-agent-metadata.json')
    const raw = await readFileOrNull(templateMetaPath)
    if (!raw) continue
    try {
      const meta = JSON.parse(raw)
      if (meta.provider !== 'platform') continue
      const ssOrgId = (meta.providerData as Record<string, unknown> | undefined)?.orgId as string | undefined
      if (keepOrgId && ssOrgId === keepOrgId) continue
      await fs.promises.unlink(templateMetaPath)
    } catch { /* skip */ }
  }
}

export function getPlatformAuthStatus(_userId?: string): PlatformAuthStatus {
  const record = readRecord()
  if (!record) {
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
    }
  }

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
  if (orgChanged && (existing?.orgId || newOrgId)) {
    if (existing?.orgId) {
      removePlatformSkillsets(existing.orgId)
    }
    await removePlatformSkillFiles(newOrgId || undefined)
  }

  const now = new Date().toISOString()
  const record: PlatformAuthRecord = {
    token: trimmedToken,
    tokenPreview: buildTokenPreview(trimmedToken),
    email: input.email?.trim() || null,
    label: input.label?.trim() || null,
    orgId: newOrgId,
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

async function clearPlatformAuth(): Promise<void> {
  removePlatformSkillsets()
  await removePlatformSkillFiles()
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
    await clearPlatformAuth()
  }
  return success
}

