import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import type { SkillsetConfig } from '@shared/lib/types/skillset'
import { ensureDirectory } from '@shared/lib/utils/file-storage'
import { getSettings } from '@shared/lib/config/settings'
import { getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'

const execFileAsync = promisify(execFile)

export const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
}

function isSkillsetAccessible(config: SkillsetConfig, currentPlatformOrgId: string | null): boolean {
  const provider = getSkillsetProvider(config.provider)
  return provider.getAccessInfo({
    currentPlatformOrgId,
    config: {
      name: config.name,
      description: config.description,
      providerData: provider.normalizeProviderData(config),
    },
    meta: {
      skillsetId: config.id,
      skillsetName: config.name,
      providerData: provider.normalizeProviderData(config),
    },
  }).isAccessible
}

export function buildSkillsetAccessScope(
  configs: SkillsetConfig[],
  currentPlatformOrgId: string | null,
) {
  return {
    configuredSkillsets: configs,
    accessibleSkillsets: configs.filter((config) => isSkillsetAccessible(config, currentPlatformOrgId)),
    currentPlatformOrgId,
  }
}

export function findAccessibleSkillsetById(
  scope: ReturnType<typeof buildSkillsetAccessScope>,
  skillsetId: string,
): SkillsetConfig | undefined {
  return scope.accessibleSkillsets.find((skillset) => skillset.id === skillsetId)
}

export type SkillsetAccessScope = ReturnType<typeof buildSkillsetAccessScope>

export function getSkillsetAccessScope(): SkillsetAccessScope {
  return buildSkillsetAccessScope(getSettings().skillsets || [], getPlatformAuthStatus().orgId)
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
