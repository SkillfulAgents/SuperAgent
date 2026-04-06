import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import type { SkillProvider, SkillsetConfig } from '@shared/lib/types/skillset'
import { ensureDirectory } from '@shared/lib/utils/file-storage'

const execFileAsync = promisify(execFile)

export const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
}

/**
 * Derive the effective skillset name from metadata fields.
 * Falls back from skillsetName → last segment of platformRepoId.
 */
export function getEffectiveSkillsetName(
  meta: { skillsetName?: string; platformRepoId?: string },
): string | undefined {
  return meta.skillsetName
    ?? (meta.platformRepoId ? meta.platformRepoId.split('/').pop() : undefined)
}

/**
 * Derive the effective repo ID used for local cache directory naming.
 * Platform providers use platformRepoId; GitHub uses skillsetId.
 */
export function getEffectiveRepoId(
  provider: SkillProvider | undefined,
  platformRepoId: string | undefined,
  skillsetId: string,
): string {
  return (provider === 'platform' && platformRepoId) ? platformRepoId : skillsetId
}

/**
 * Platform repo IDs are namespaced as {namespace}/{orgId}/{skillsetName}.
 */
export function getPlatformOrgIdFromRepoId(platformRepoId?: string): string | undefined {
  if (!platformRepoId) return undefined
  const parts = platformRepoId.split('/')
  return parts.length >= 3 ? parts[1] : undefined
}

/**
 * Prefer stored org names; fall back to legacy platform descriptions like
 * "Default skillset for DataWizz Demo Org".
 */
export function getPlatformOrgName(config?: Pick<SkillsetConfig, 'platformOrgName' | 'description'>): string | undefined {
  if (!config) return undefined
  if (config.platformOrgName) return config.platformOrgName

  const prefix = 'Default skillset for '
  if (config.description?.startsWith(prefix)) {
    return config.description.slice(prefix.length).trim() || undefined
  }

  return undefined
}

export function resolvePlatformSkillsetScope(params: {
  provider?: SkillProvider
  currentPlatformOrgId?: string | null
  config?: Pick<SkillsetConfig, 'name' | 'description' | 'platformOrgId' | 'platformOrgName' | 'platformRepoId'>
  meta: {
    skillsetId: string
    skillsetName?: string
    platformRepoId?: string
  }
}) {
  const skillsetOrgId =
    params.config?.platformOrgId
    || getPlatformOrgIdFromRepoId(params.config?.platformRepoId)
    || getPlatformOrgIdFromRepoId(params.meta.platformRepoId)
  const skillsetOrgName = getPlatformOrgName(params.config)
  const skillsetName =
    params.config?.name
    || getEffectiveSkillsetName(params.meta)
    || params.meta.skillsetId
  const isCurrentPlatformOrg =
    params.provider !== 'platform'
    || !skillsetOrgId
    || skillsetOrgId === params.currentPlatformOrgId

  return {
    skillsetName,
    skillsetOrgId,
    skillsetOrgName,
    isCurrentPlatformOrg,
  }
}

/**
 * Hide platform skillsets that do not belong to the currently connected org.
 * Non-platform skillsets are always kept.
 */
export function filterSkillsetsForCurrentPlatformOrg(
  configs: SkillsetConfig[],
  currentPlatformOrgId: string | null,
): SkillsetConfig[] {
  return configs.filter((config) => {
    if (config.provider !== 'platform') return true
    if (!currentPlatformOrgId) return false
    return config.platformOrgId === currentPlatformOrgId
  })
}

export function buildSkillsetScope(
  configs: SkillsetConfig[],
  currentPlatformOrgId: string | null,
) {
  return {
    allSkillsets: configs,
    visibleSkillsets: filterSkillsetsForCurrentPlatformOrg(configs, currentPlatformOrgId),
    currentPlatformOrgId,
  }
}

export function findVisibleSkillsetById(
  scope: ReturnType<typeof buildSkillsetScope>,
  skillsetId: string,
): SkillsetConfig | undefined {
  return scope.visibleSkillsets.find((skillset) => skillset.id === skillsetId)
}

/**
 * Ensure GitHub CLI is installed and authenticated. Throws descriptive errors.
 */
export async function ensureGhAuthenticated(): Promise<void> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 })
  } catch {
    throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com')
  }

  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 })
  } catch {
    throw new Error('GitHub CLI is not authenticated. Run `gh auth login` to sign in. See https://cli.github.com')
  }
}

const DEFAULT_EXCLUDED = new Set(['.git', '.skillset-metadata.json', '.skillset-original.md'])

/**
 * Recursively copy a directory, excluding internal skillset/git files.
 */
export async function copyDirectoryFiltered(
  src: string,
  dest: string,
  extraExclusions?: string[],
): Promise<void> {
  await ensureDirectory(dest)
  const entries = await fs.promises.readdir(src, { withFileTypes: true })

  const excluded = extraExclusions
    ? new Set([...DEFAULT_EXCLUDED, ...extraExclusions])
    : DEFAULT_EXCLUDED

  for (const entry of entries) {
    if (excluded.has(entry.name)) continue

    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectoryFiltered(srcPath, destPath, extraExclusions)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

/**
 * Write a JSON object to a file with pretty formatting.
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}
