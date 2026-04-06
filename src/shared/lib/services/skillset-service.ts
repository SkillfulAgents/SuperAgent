/**
 * Skillset Service
 *
 * Core backend service for managing skillsets (git repositories of skills).
 * Handles: cloning/caching repos, reading index.json, installing skills,
 * version tracking, status detection, and PR creation.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import yaml from 'js-yaml'
import { getDataDir } from '@shared/lib/config/data-dir'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { withRetry } from '@shared/lib/utils/retry'
import {
  getAgentWorkspaceDir,
  readFileOrNull,
  ensureDirectory,
  directoryExists,
} from '@shared/lib/utils/file-storage'
import type {
  SkillsetIndex,
  SkillsetConfig,
  InstalledSkillMetadata,
  SkillFrontmatterMetadata,
  DiscoverableSkill,
  SkillWithStatus,
  SkillStatus,
  SkillProvider,
} from '@shared/lib/types/skillset'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  GIT_ENV,
  getEffectiveSkillsetName,
  getEffectiveRepoId,
  ensureGhAuthenticated,
  copyDirectoryFiltered,
  writeJsonFile,
} from '@shared/lib/utils/skillset-helpers'

const execFileAsync = promisify(execFile)

// ============================================================================
// Path Helpers
// ============================================================================

function getSkillsetCacheDir(): string {
  return path.join(getDataDir(), 'skillset-cache')
}

export function getSkillsetRepoDir(skillsetId: string): string {
  const safeName = skillsetId.replace(/\//g, '--')
  return path.join(getSkillsetCacheDir(), safeName)
}

function getAgentSkillsDir(agentSlug: string): string {
  return path.join(getAgentWorkspaceDir(agentSlug), '.claude', 'skills')
}

function getSkillMetadataPath(agentSlug: string, skillDirName: string): string {
  return path.join(getAgentSkillsDir(agentSlug), sanitizeDirName(skillDirName), '.skillset-metadata.json')
}

/**
 * Sanitize a directory name to prevent path traversal.
 * Rejects names containing path separators or `..`.
 */
function sanitizeDirName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid directory name: ${name}`)
  }
  return name
}

// ============================================================================
// URL / ID Helpers
// ============================================================================

/**
 * Convert a git URL to a deterministic skillset ID.
 * "https://github.com/DatawizzAI/skills" -> "github-com-datawizzai-skills"
 * "git@github.com:DatawizzAI/skills.git" -> "github-com-datawizzai-skills"
 */
export function urlToSkillsetId(url: string): string {
  return url
    .replace(/^(https?:\/\/|git@)/, '')
    .replace(/\.git$/, '')
    .replace(/:/g, '/')
    .replace(/[^a-zA-Z0-9/]+/g, '-')
    .replace(/\//g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
}

/**
 * Get the skill directory name from a skillset skill path.
 * "skills/supabase-query/SKILL.md" -> "supabase-query"
 */
function skillPathToDirName(skillPath: string): string {
  // Remove the SKILL.md filename, get the parent directory name
  const dir = path.dirname(skillPath)
  return path.basename(dir)
}

// ============================================================================
// Content Hashing
// ============================================================================

/** Compute SHA-256 hash of content */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex')
}

// ============================================================================
// SKILL.md Frontmatter Parsing
// ============================================================================

/**
 * Parse the full YAML frontmatter from a SKILL.md file,
 * including nested metadata (version, required_env_vars).
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatterMetadata {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}

  try {
    const parsed = yaml.load(match[1]) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return {}

    const metadata = (parsed.metadata as Record<string, unknown>) || {}
    const result: SkillFrontmatterMetadata = {}

    if (typeof parsed.name === 'string') {
      result.name = parsed.name
    }

    if (metadata.version !== undefined) {
      result.version = String(metadata.version)
    }

    if (Array.isArray(metadata.required_env_vars)) {
      result.required_env_vars = metadata.required_env_vars
        .filter((v: unknown) => v && typeof v === 'object' && 'name' in (v as Record<string, unknown>))
        .map((v: unknown) => {
          const obj = v as Record<string, unknown>
          return {
            name: String(obj.name),
            description: String(obj.description || ''),
          }
        })
    }

    return result
  } catch {
    return {}
  }
}

/**
 * Parse the description from SKILL.md frontmatter (simple extraction).
 */
function parseDescription(content: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return 'No description provided'

  try {
    const parsed = yaml.load(match[1]) as Record<string, unknown> | null
    if (parsed && typeof parsed === 'object' && typeof parsed.description === 'string') {
      return parsed.description
    }
  } catch {
    // fall through
  }
  return 'No description provided'
}

/**
 * Get display name from a skill directory name.
 * Converts kebab-case to Title Case.
 */
function getDisplayName(dirName: string): string {
  return dirName
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// ============================================================================
// Git Operations
// ============================================================================


async function gitClone(url: string, dest: string): Promise<void> {
  try {
    await execFileAsync('git', ['clone', '--depth', '1', url, dest], {
      timeout: 60000,
      env: GIT_ENV,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Git returns "not found" or "does not exist" for both missing and private repos
    if (/not found|does not exist|Could not read from remote|Permission denied/i.test(msg)) {
      throw new Error(
        `Could not access repository: ${url}\n\n` +
        'This may be a private repository. To access private repos, configure SSH authentication:\n' +
        'https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent'
      )
    }
    throw error
  }
}

async function gitPull(repoDir: string): Promise<void> {
  await execFileAsync('git', ['pull'], {
    cwd: repoDir,
    timeout: 30000,
    env: GIT_ENV,
  })
}

async function isGitRepo(dir: string): Promise<boolean> {
  return directoryExists(path.join(dir, '.git'))
}

/**
 * Recover original file content from git history by finding the commit
 * whose version of the file matches the expected hash.
 */
async function getOriginalFromGitHistory(
  repoDir: string,
  filePath: string,
  expectedHash: string,
): Promise<string | null> {
  try {
    // List all commits that touched this file
    const { stdout: logOutput } = await execFileAsync(
      'git', ['log', '--all', '--format=%H', '--', filePath],
      { cwd: repoDir, timeout: 10000, env: GIT_ENV }
    )
    const commits = logOutput.trim().split('\n').filter(Boolean)

    for (const commitHash of commits) {
      try {
        const { stdout: fileContent } = await execFileAsync(
          'git', ['show', `${commitHash}:${filePath}`],
          { cwd: repoDir, timeout: 10000, env: GIT_ENV }
        )
        if (contentHash(fileContent) === expectedHash) {
          return fileContent
        }
      } catch {
        // Commit might not have this file, skip
      }
    }
  } catch {
    // Git operations failed
  }
  return null
}

// ============================================================================
// Platform Provider Helpers
// ============================================================================

/**
 * Resolve the effective clone URL. For platform provider, exchanges the
 * platform Bearer token for a short-lived JWT-authenticated Git URL via proxy.
 */
async function resolveCloneUrl(url: string, provider?: SkillProvider, skillsetName?: string): Promise<string> {
  if (provider !== 'platform') return url

  const proxyBase = getPlatformProxyBaseUrl()
  const token = getPlatformAccessToken()
  if (!proxyBase || !token) {
    throw new Error('Platform not connected. Please connect to platform first.')
  }

  if (!skillsetName) {
    throw new Error('skillsetName is required for platform provider')
  }

  const fetchUrl = `${proxyBase}/v1/skills/git-url?skillset=${encodeURIComponent(skillsetName)}`
  const res = await fetch(fetchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new Error(`Failed to get platform Git URL: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as { url: string; defaultBranch: string }
  return data.url
}

// ============================================================================
// Skillset Cache Management
// ============================================================================

/**
 * Ensure a skillset repo is cached locally. Clones if not present.
 * Returns the path to the cached repo.
 */
export async function ensureGitInstalled(): Promise<void> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000 })
  } catch {
    throw new Error(
      'Git is not installed. Install it from https://git-scm.com/install/mac'
    )
  }
}

export async function ensureSkillsetCached(
  skillsetId: string,
  url: string,
  provider?: SkillProvider,
  platformRepoId?: string,
  skillsetName?: string,
): Promise<string> {
  const effectiveId = getEffectiveRepoId(provider, platformRepoId, skillsetId)
  const repoDir = getSkillsetRepoDir(effectiveId)

  if (await isGitRepo(repoDir)) return repoDir

  await ensureGitInstalled()
  await ensureDirectory(getSkillsetCacheDir())

  const parentDir = path.dirname(repoDir)
  if (parentDir !== getSkillsetCacheDir()) {
    await ensureDirectory(parentDir)
  }

  if (await directoryExists(repoDir)) {
    await fs.promises.rm(repoDir, { recursive: true, force: true })
  }

  const cloneUrl = await resolveCloneUrl(url, provider, skillsetName)
  await gitClone(cloneUrl, repoDir)
  return repoDir
}

/**
 * Read and parse index.json from a cached skillset repo.
 */
export async function readIndexJson(repoDir: string): Promise<SkillsetIndex> {
  const indexPath = path.join(repoDir, 'index.json')
  const content = await readFileOrNull(indexPath)
  if (!content) {
    throw new Error(`index.json not found in skillset repository at ${indexPath}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error('index.json contains invalid JSON')
  }

  const parsed = raw as Record<string, unknown>
  if (!parsed.skillset_name || !Array.isArray(parsed.skills)) {
    throw new Error('Invalid index.json: missing skillset_name or skills array')
  }

  return raw as SkillsetIndex
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Validate a skillset URL by cloning the repo and reading index.json.
 * Returns the parsed index on success.
 */
export async function validateSkillsetUrl(url: string, provider?: SkillProvider): Promise<SkillsetIndex> {
  const skillsetId = urlToSkillsetId(url)
  const repoDir = await ensureSkillsetCached(skillsetId, url, provider)
  return readIndexJson(repoDir)
}

/**
 * Refresh a cached skillset repo (git pull) and return the updated index.
 */
export async function refreshSkillset(
  skillsetId: string,
  url: string,
  provider?: SkillProvider,
  platformRepoId?: string,
  skillsetName?: string,
): Promise<SkillsetIndex> {
  const effectiveId = getEffectiveRepoId(provider, platformRepoId, skillsetId)
  const repoDir = getSkillsetRepoDir(effectiveId)

  if (await isGitRepo(repoDir)) {
    if (provider === 'platform') {
      const freshUrl = await resolveCloneUrl(url, provider, skillsetName)
      await execFileAsync('git', ['remote', 'set-url', 'origin', freshUrl], {
        cwd: repoDir, timeout: 5000, env: GIT_ENV,
      })
    }
    await gitPull(repoDir)
  } else {
    await ensureSkillsetCached(skillsetId, url, provider, platformRepoId, skillsetName)
  }

  return readIndexJson(repoDir)
}

/**
 * Get the skillset index from local cache (no network).
 */
export async function getSkillsetIndex(
  skillsetId: string,
  options?: { platformRepoId?: string; skillsetName?: string },
): Promise<SkillsetIndex | null> {
  const effectiveId = options?.platformRepoId || skillsetId
  const repoDir = getSkillsetRepoDir(effectiveId)
  if (!await isGitRepo(repoDir)) return null

  try {
    return await readIndexJson(repoDir)
  } catch {
    return null
  }
}

/**
 * Remove a skillset cache directory.
 */
export async function removeSkillsetCache(skillsetId: string): Promise<void> {
  const repoDir = getSkillsetRepoDir(skillsetId)
  if (await directoryExists(repoDir)) {
    await fs.promises.rm(repoDir, { recursive: true, force: true })
  }
}

/**
 * Install a skill from a skillset to an agent's workspace.
 * Returns the required env vars (if any) so the UI can prompt the user.
 */
export async function installSkillFromSkillset(
  agentSlug: string,
  skillsetId: string,
  skillsetUrl: string,
  skillPath: string,
  skillName: string,
  skillVersion: string,
  provider?: SkillProvider,
  platformRepoId?: string,
  skillsetName?: string,
): Promise<{ requiredEnvVars?: Array<{ name: string; description: string }> }> {
  const repoDir = getSkillsetRepoDir(getEffectiveRepoId(provider, platformRepoId, skillsetId))
  if (!(await isGitRepo(repoDir))) {
    await ensureSkillsetCached(skillsetId, skillsetUrl, provider, platformRepoId, skillsetName)
  }

  // Determine source and destination directories
  const skillDirInRepo = path.join(repoDir, path.dirname(skillPath))
  const skillDirName = sanitizeDirName(skillPathToDirName(skillPath))
  const destDir = path.join(getAgentSkillsDir(agentSlug), skillDirName)

  if (!(await directoryExists(skillDirInRepo))) {
    throw new Error(`Skill directory not found in skillset: ${path.dirname(skillPath)}`)
  }

  // Create destination directory
  await ensureDirectory(destDir)

  // Copy all files from the skill directory
  await copyDirectoryFiltered(skillDirInRepo, destDir)

  // Read the installed SKILL.md to compute hash and parse metadata
  const skillMdPath = path.join(destDir, 'SKILL.md')
  const skillContent = await readFileOrNull(skillMdPath)
  if (!skillContent) {
    throw new Error('SKILL.md not found after installation')
  }

  const hash = contentHash(skillContent)
  const frontmatter = parseSkillFrontmatter(skillContent)

  // Write metadata file
  const metadata: InstalledSkillMetadata = {
    skillsetId,
    skillsetUrl,
    skillName,
    skillPath,
    installedVersion: skillVersion,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    provider,
    platformRepoId,
    skillsetName,
  }

  await fs.promises.writeFile(
    path.join(destDir, '.skillset-metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  )

  // Store original content for diff generation (used by PR suggestions)
  await fs.promises.writeFile(
    path.join(destDir, '.skillset-original.md'),
    skillContent,
    'utf-8'
  )

  return { requiredEnvVars: frontmatter.required_env_vars }
}

/**
 * Update an installed skill to the latest version from its skillset.
 */
export async function updateSkillFromSkillset(
  agentSlug: string,
  skillDirName: string,
): Promise<{ updated: boolean }> {
  sanitizeDirName(skillDirName)
  const metadataPath = getSkillMetadataPath(agentSlug, skillDirName)
  const metaContent = await readFileOrNull(metadataPath)
  if (!metaContent) {
    return { updated: false }
  }

  let meta: InstalledSkillMetadata
  try {
    meta = JSON.parse(metaContent)
  } catch {
    return { updated: false }
  }

  const effectiveSkillsetName = getEffectiveSkillsetName(meta)

  // Refresh the skillset cache
  await refreshSkillset(meta.skillsetId, meta.skillsetUrl, meta.provider, meta.platformRepoId, effectiveSkillsetName)

  // Re-install the skill (overwrites existing)
  const index = await getSkillsetIndex(meta.skillsetId, {
    platformRepoId: meta.platformRepoId,
    skillsetName: effectiveSkillsetName,
  })
  if (!index) return { updated: false }

  const skillEntry = index.skills.find((s) => s.path === meta.skillPath)
  if (!skillEntry) return { updated: false }

  await installSkillFromSkillset(
    agentSlug,
    meta.skillsetId,
    meta.skillsetUrl,
    meta.skillPath,
    meta.skillName,
    skillEntry.version,
    meta.provider,
    meta.platformRepoId,
    effectiveSkillsetName,
  )

  return { updated: true }
}

/**
 * Read installed skill metadata from .skillset-metadata.json.
 */
export async function getInstalledSkillMetadata(
  agentSlug: string,
  skillDirName: string,
): Promise<InstalledSkillMetadata | null> {
  const metadataPath = getSkillMetadataPath(agentSlug, skillDirName)
  const content = await readFileOrNull(metadataPath)
  if (!content) return null

  try {
    return JSON.parse(content) as InstalledSkillMetadata
  } catch {
    return null
  }
}

/**
 * Get all agent skills with version/status info.
 */
export async function getAgentSkillsWithStatus(
  agentSlug: string,
  skillsets: SkillsetConfig[],
): Promise<SkillWithStatus[]> {
  const skillsDir = getAgentSkillsDir(agentSlug)

  if (!fs.existsSync(skillsDir)) {
    return []
  }

  // Build a map of skillset indexes for quick lookup
  const indexMap = new Map<string, SkillsetIndex>()
  for (const ss of skillsets) {
    const index = await getSkillsetIndex(ss.id, {
      platformRepoId: ss.platformRepoId,
    })
    if (index) indexMap.set(ss.id, index)
  }

  // Build a map of skillset names and configs for platform repo resolution
  const skillsetNameMap = new Map<string, string>()
  const skillsetConfigMap = new Map<string, SkillsetConfig>()
  for (const ss of skillsets) {
    skillsetNameMap.set(ss.id, ss.name)
    skillsetConfigMap.set(ss.id, ss)
  }

  const skills: SkillWithStatus[] = []
  const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillPath = path.join(skillsDir, entry.name)
    const skillMdPath = path.join(skillPath, 'SKILL.md')
    const skillMdContent = await readFileOrNull(skillMdPath)

    if (!skillMdContent) continue

    const description = parseDescription(skillMdContent)
    const frontmatter = parseSkillFrontmatter(skillMdContent)
    const meta = await getInstalledSkillMetadata(agentSlug, entry.name)

    let status: SkillStatus

    if (!meta) {
      // Not from a skillset
      status = { type: 'local' }
    } else {
      const skillsetName =
        skillsetNameMap.get(meta.skillsetId)
        || getEffectiveSkillsetName(meta)
        || meta.skillsetId

      // If there's a pending platform submission, check its status
      if (meta.pendingQueueItemId && meta.provider === 'platform') {
        const queueStatus = await checkPlatformQueueItemStatus(meta.pendingQueueItemId)
        if (queueStatus === 'merged' || queueStatus === 'rejected') {
          if (queueStatus === 'merged') {
            try {
              await refreshSkillset(meta.skillsetId, meta.skillsetUrl, meta.provider, meta.platformRepoId, getEffectiveSkillsetName(meta))
            } catch { /* best-effort pull */ }
            const effectiveRepoId = meta.platformRepoId || meta.skillsetId
            const repoDir = getSkillsetRepoDir(effectiveRepoId)
            const mergedContent = await readFileOrNull(path.join(repoDir, meta.skillPath))
            if (mergedContent) {
              const mergedHash = contentHash(mergedContent)
              meta.originalContentHash = mergedHash
              const localSkillMdPath = path.join(skillPath, 'SKILL.md')
              await fs.promises.writeFile(localSkillMdPath, mergedContent, 'utf-8')
              await fs.promises.writeFile(
                path.join(skillPath, '.skillset-original.md'),
                mergedContent,
                'utf-8',
              )
            } else {
              meta.originalContentHash = contentHash(skillMdContent)
            }
          }
          meta.pendingQueueItemId = undefined
          await writeJsonFile(getSkillMetadataPath(agentSlug, entry.name), meta)
        }
      }

      // Check for local modifications
      const currentHash = contentHash(skillMdContent)
      if (currentHash !== meta.originalContentHash) {
        status = { type: 'locally_modified', skillsetId: meta.skillsetId, skillsetName, openPrUrl: meta.openPrUrl }
      } else if (meta.openPrUrl) {
        status = { type: 'locally_modified', skillsetId: meta.skillsetId, skillsetName, openPrUrl: meta.openPrUrl }
      } else {
        // Check for updates
        const index = indexMap.get(meta.skillsetId)
        const skillEntry = index?.skills.find((s) => s.path === meta.skillPath)

        if (skillEntry && skillEntry.version && skillEntry.version !== meta.installedVersion) {
          status = {
            type: 'update_available',
            skillsetId: meta.skillsetId,
            skillsetName,
            latestVersion: skillEntry.version,
          }
        } else {
          status = { type: 'up_to_date', skillsetId: meta.skillsetId, skillsetName }
        }
      }
    }

    skills.push({
      name: meta?.skillName || frontmatter.name || getDisplayName(entry.name),
      description,
      path: entry.name,
      status,
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Refresh all skillset caches and reconcile skill status.
 * If a locally modified skill now matches the upstream cache (e.g. PR was merged),
 * update the metadata so status becomes up_to_date.
 */
export async function refreshAgentSkills(
  agentSlug: string,
  skillsets: SkillsetConfig[],
): Promise<void> {
  // Build a config lookup for resolving platform repo paths
  const configMap = new Map<string, SkillsetConfig>()
  for (const ss of skillsets) configMap.set(ss.id, ss)

  // Refresh all skillset caches
  for (const ss of skillsets) {
    try {
      await refreshSkillset(ss.id, ss.url, ss.provider, ss.platformRepoId, ss.name)
    } catch (error) {
      console.warn(`Failed to refresh skillset ${ss.id}:`, error)
    }
  }

  // Reconcile: if local content now matches cache, update metadata
  const skillsDir = getAgentSkillsDir(agentSlug)
  if (!fs.existsSync(skillsDir)) return

  const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const meta = await getInstalledSkillMetadata(agentSlug, entry.name)
    if (!meta) continue

    const skillMdContent = await readFileOrNull(
      path.join(skillsDir, entry.name, 'SKILL.md')
    )
    if (!skillMdContent) continue

    const currentHash = contentHash(skillMdContent)

    // Resolve the correct repo directory (platform skillsets may share a clone)
    const ssConfig = configMap.get(meta.skillsetId)
    const effectiveRepoId = ssConfig?.platformRepoId || meta.skillsetId
    const skillRepoDir = getSkillsetRepoDir(effectiveRepoId)

    // For published skills (openPrUrl set, hash matches original):
    // check if the skill now appears in the upstream cache (PR merged)
    if (currentHash === meta.originalContentHash && meta.openPrUrl) {
      const cacheContent = await readFileOrNull(path.join(skillRepoDir, meta.skillPath))
      if (cacheContent && contentHash(cacheContent) === currentHash) {
        meta.openPrUrl = undefined
        await fs.promises.writeFile(
          getSkillMetadataPath(agentSlug, entry.name),
          JSON.stringify(meta, null, 2),
          'utf-8'
        )
      }
      continue
    }

    if (currentHash === meta.originalContentHash) continue // already in sync

    // Check if local content now matches the refreshed cache
    const cacheContent = await readFileOrNull(path.join(skillRepoDir, meta.skillPath))
    if (cacheContent && contentHash(cacheContent) === currentHash) {
      // Changes were merged upstream — update metadata to new baseline
      meta.originalContentHash = currentHash
      meta.openPrUrl = undefined
      await fs.promises.writeFile(
        getSkillMetadataPath(agentSlug, entry.name),
        JSON.stringify(meta, null, 2),
        'utf-8'
      )
      // Also update stored original
      await fs.promises.writeFile(
        path.join(skillsDir, entry.name, '.skillset-original.md'),
        skillMdContent,
        'utf-8'
      )
    }
  }
}

/**
 * Get discoverable skills from all configured skillsets that aren't already installed.
 */
export async function getDiscoverableSkills(
  agentSlug: string,
  skillsets: SkillsetConfig[],
): Promise<DiscoverableSkill[]> {
  // Get set of already-installed skill directory names
  const skillsDir = getAgentSkillsDir(agentSlug)
  const installedDirs = new Set<string>()

  if (fs.existsSync(skillsDir)) {
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) installedDirs.add(entry.name)
    }
  }

  const discoverable: DiscoverableSkill[] = []

  for (const ss of skillsets) {
    const index = await getSkillsetIndex(ss.id, {
      platformRepoId: ss.platformRepoId,
    })
    if (!index) continue

    for (const skill of index.skills) {
      const dirName = skillPathToDirName(skill.path)
      if (installedDirs.has(dirName)) continue

      // Try to get required_env_vars from the cached SKILL.md
      let requiredEnvVars: Array<{ name: string; description: string }> | undefined
      const effectiveRepoId = ss.platformRepoId || ss.id
      const repoDir = getSkillsetRepoDir(effectiveRepoId)
      const skillMdPath = path.join(repoDir, skill.path)
      const content = await readFileOrNull(skillMdPath)
      if (content) {
        const meta = parseSkillFrontmatter(content)
        requiredEnvVars = meta.required_env_vars
      }

      discoverable.push({
        skillsetId: ss.id,
        skillsetName: ss.name,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        path: skill.path,
        requiredEnvVars,
      })
    }
  }

  return discoverable.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Use the summarizer model to generate PR title, body, and SemVer version suggestion
 * based on the diff between original and modified SKILL.md.
 */
async function generatePRSuggestions(
  meta: InstalledSkillMetadata,
  agentSlug: string,
  skillDirName: string,
): Promise<{ suggestedTitle: string; suggestedBody: string; suggestedVersion: string }> {
  const fallback = {
    suggestedTitle: `Update ${meta.skillName} skill`,
    suggestedBody: `Updated ${meta.skillName} skill with local modifications.`,
    suggestedVersion: meta.installedVersion,
  }

  const skillDir = path.join(getAgentSkillsDir(agentSlug), skillDirName)
  const effectiveRepoId = meta.platformRepoId || meta.skillsetId
  const repoDir = getSkillsetRepoDir(effectiveRepoId)

  // Read original SKILL.md: prefer stored copy, fall back to git history
  let originalContent = await readFileOrNull(path.join(skillDir, '.skillset-original.md'))
  if (!originalContent) {
    originalContent = await getOriginalFromGitHistory(
      repoDir, meta.skillPath, meta.originalContentHash
    )
  }
  if (!originalContent) {
    console.warn('[PR suggestions] Could not recover original content')
    return fallback
  }

  // Read modified SKILL.md from agent workspace
  const modifiedContent = await readFileOrNull(path.join(skillDir, 'SKILL.md'))
  if (!modifiedContent) {
    console.warn('[PR suggestions] Modified SKILL.md not found')
    return fallback
  }

  if (originalContent === modifiedContent) {
    return fallback
  }

  const provider = getActiveLlmProvider()
  if (!provider.getApiKeyStatus().isConfigured) {
    console.warn('[PR suggestions] No LLM API key configured')
    return fallback
  }

  try {
    const client = provider.createClient()
    const model = getEffectiveModels().summarizerModel

    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: `You are analyzing changes to a skill definition file (SKILL.md). Compare the original and modified versions and generate a PR title, description, and new SemVer version.

Current version: ${meta.installedVersion}

Original SKILL.md:
\`\`\`
${originalContent}
\`\`\`

Modified SKILL.md:
\`\`\`
${modifiedContent}
\`\`\`

Rules for the version bump:
- PATCH (x.y.Z): bug fixes, typo corrections, minor wording tweaks
- MINOR (x.Y.0): new features, added capabilities, significant improvements
- MAJOR (X.0.0): breaking changes, fundamental restructuring`,
          },
        ],
        output_config: {
          format: {
            type: 'json_schema' as const,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Concise imperative PR title' },
                body: { type: 'string', description: 'Markdown description of what changed' },
                version: { type: 'string', description: 'New SemVer version' },
              },
              required: ['title', 'body', 'version'],
              additionalProperties: false,
            },
          },
        },
      })
    )

    const textBlock = response.content.find((block) => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') return fallback

    const parsed = JSON.parse(textBlock.text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch (error) {
    console.error('Failed to generate PR suggestions via AI:', error)
    return fallback
  }
}

/**
 * Get metadata needed to prepare a PR dialog, including AI-generated suggestions.
 */
export async function getSkillPRInfo(
  agentSlug: string,
  skillDirName: string,
): Promise<{
  skillName: string
  skillPath: string
  skillsetUrl: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}> {
  sanitizeDirName(skillDirName)
  const meta = await getInstalledSkillMetadata(agentSlug, skillDirName)
  if (!meta) {
    throw new Error('Skill has no skillset metadata - cannot create PR')
  }

  await ensureGhAuthenticated()

  const suggestions = await generatePRSuggestions(meta, agentSlug, skillDirName)

  return {
    skillName: meta.skillName,
    skillPath: meta.skillPath,
    skillsetUrl: meta.skillsetUrl,
    ...suggestions,
  }
}

// ============================================================================
// Shared Git Fork/Branch/PR Helper
// ============================================================================

export interface ForkBranchContext {
  repoDir: string
  upstreamNwo: string
  forkOwner: string
  baseBranch: string
  branchName: string
}

/**
 * Prepare a git fork, feature branch, and remote for creating a PR.
 * Handles: cleanup, fork, remote setup, base branch detection, and branch creation.
 */
export async function prepareForkBranch(
  repoDir: string,
  branchPrefix: string,
): Promise<ForkBranchContext> {
  // Clean up any leftover state from previous failed attempts
  await execFileAsync('git', ['checkout', '.'], {
    cwd: repoDir, timeout: 5000, env: GIT_ENV,
  }).catch(() => { /* ignore */ })

  // Get the upstream repo nwo (name-with-owner e.g. "DatawizzAI/skills")
  const { stdout: upstreamNwoRaw } = await execFileAsync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: repoDir, timeout: 10000 }
  )
  const upstreamNwo = upstreamNwoRaw.trim()

  // Fork the skillset repo (idempotent - no-op if already forked)
  await execFileAsync('gh', ['repo', 'fork', '--clone=false', '--remote=false'], {
    cwd: repoDir,
    timeout: 30000,
  })

  // Get the authenticated user's login to identify the fork
  const { stdout: userLogin } = await execFileAsync(
    'gh',
    ['api', 'user', '--jq', '.login'],
    { timeout: 10000 }
  )
  const forkOwner = userLogin.trim()
  const repoName = upstreamNwo.split('/')[1]

  // Ensure the fork remote is configured
  const forkRemoteName = 'fork'
  const forkUrl = `https://github.com/${forkOwner}/${repoName}.git`

  try {
    await execFileAsync('git', ['remote', 'add', forkRemoteName, forkUrl], {
      cwd: repoDir, timeout: 5000, env: GIT_ENV,
    })
  } catch {
    await execFileAsync('git', ['remote', 'set-url', forkRemoteName, forkUrl], {
      cwd: repoDir, timeout: 5000, env: GIT_ENV,
    })
  }

  // Determine the default branch
  let baseBranch = 'main'
  try {
    const { stdout: originHead } = await execFileAsync(
      'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoDir, timeout: 5000, env: GIT_ENV }
    )
    baseBranch = originHead.trim().replace('refs/remotes/origin/', '')
  } catch {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', 'origin/main'],
        { cwd: repoDir, timeout: 5000, env: GIT_ENV })
      baseBranch = 'main'
    } catch {
      baseBranch = 'master'
    }
  }

  // Switch to the default branch before creating a new feature branch
  await execFileAsync('git', ['checkout', baseBranch], {
    cwd: repoDir, timeout: 10000, env: GIT_ENV,
  })

  const branchName = `${branchPrefix}-${Date.now()}`
  await execFileAsync('git', ['checkout', '-b', branchName], {
    cwd: repoDir, timeout: 10000, env: GIT_ENV,
  })

  return { repoDir, upstreamNwo, forkOwner, baseBranch, branchName }
}

/**
 * Push staged changes and create a PR. Always cleans up the local branch afterwards.
 */
export async function pushAndCreatePR(
  ctx: ForkBranchContext,
  options: { title: string; body: string },
): Promise<string> {
  await execFileAsync('git', ['push', 'fork', ctx.branchName], {
    cwd: ctx.repoDir, timeout: 30000, env: GIT_ENV,
  })

  try {
    const { stdout: prStdout } = await execFileAsync(
      'gh',
      [
        'pr', 'create',
        '--repo', ctx.upstreamNwo,
        '--title', options.title,
        '--body', options.body,
        '--head', `${ctx.forkOwner}:${ctx.branchName}`,
        '--base', ctx.baseBranch,
      ],
      { cwd: ctx.repoDir, timeout: 30000 }
    )
    return prStdout.trim()
  } finally {
    await execFileAsync('git', ['checkout', ctx.baseBranch], {
      cwd: ctx.repoDir, timeout: 10000, env: GIT_ENV,
    }).catch(() => { /* ignore */ })

    await execFileAsync('git', ['branch', '-D', ctx.branchName], {
      cwd: ctx.repoDir, timeout: 5000, env: GIT_ENV,
    }).catch(() => { /* ignore */ })
  }
}

/**
 * Check the status of a platform queue item by fetching the org queue
 * and finding the item by ID.
 * Returns 'pending' | 'merged' | 'rejected' | null (if not found).
 */
async function checkPlatformQueueItemStatus(
  queueItemId: string,
): Promise<string | null> {
  const proxyBase = getPlatformProxyBaseUrl()
  const token = getPlatformAccessToken()
  if (!proxyBase || !token) return null

  try {
    const res = await fetch(`${proxyBase}/v1/skills/queue/${encodeURIComponent(queueItemId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null

    const data = await res.json() as { item: { id: string; status: string } }
    return data.item?.status ?? null
  } catch {
    return null
  }
}

/**
 * Submit a skill update to the platform via proxy submit-update API.
 */
type PlatformSubmitResult = {
  status: string
  queueItem?: { id: string; branch_name: string; status: string }
}

async function submitSkillToPlatform(
  meta: InstalledSkillMetadata,
  files: Array<{ path: string; content: string }>,
  title: string,
  message: string,
): Promise<PlatformSubmitResult> {
  const proxyBase = getPlatformProxyBaseUrl()
  const token = getPlatformAccessToken()
  if (!proxyBase || !token) {
    throw new Error('Platform not connected. Please connect to platform first.')
  }

  const skillsetName = getEffectiveSkillsetName(meta) ?? meta.skillsetId
  const targetName = path.basename(path.dirname(meta.skillPath))

  const res = await fetch(`${proxyBase}/v1/skills/submit-update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      skillsetName,
      targetName,
      targetType: 'skill',
      files,
      title,
      message,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Platform submit failed: ${res.status} ${body}`)
  }

  return await res.json() as PlatformSubmitResult
}

/**
 * Create a PR for local modifications to a skill using gh CLI.
 * For platform provider, submits via proxy submit-update instead.
 * Accepts user-provided title, body, and optional new version.
 */
export async function createSkillPR(
  agentSlug: string,
  skillDirName: string,
  options: {
    title: string
    body: string
    newVersion?: string
  },
): Promise<{ prUrl: string }> {
  sanitizeDirName(skillDirName)
  const meta = await getInstalledSkillMetadata(agentSlug, skillDirName)
  if (!meta) {
    throw new Error('Skill has no skillset metadata - cannot create PR')
  }

  // Read the modified SKILL.md
  const skillMdPath = path.join(getAgentSkillsDir(agentSlug), skillDirName, 'SKILL.md')
  let modifiedContent = await readFileOrNull(skillMdPath)
  if (!modifiedContent) {
    throw new Error('SKILL.md not found')
  }

  // If a new version was specified, update the version in the frontmatter
  if (options.newVersion) {
    modifiedContent = updateFrontmatterVersion(modifiedContent, options.newVersion)
  }

  // Platform provider: submit via proxy API instead of fork+PR
  if (meta.provider === 'platform') {
    const modifiedHash = contentHash(modifiedContent)
    const result = await submitSkillToPlatform(
      meta,
      [{ path: meta.skillPath, content: modifiedContent }],
      options.title,
      options.body,
    )

    if (result.queueItem?.id && result.status !== 'merged') {
      meta.pendingQueueItemId = result.queueItem.id
    } else if (result.status === 'merged') {
      await refreshSkillset(meta.skillsetId, meta.skillsetUrl, meta.provider, meta.platformRepoId, getEffectiveSkillsetName(meta))
      meta.originalContentHash = modifiedHash
      meta.pendingQueueItemId = undefined
      await fs.promises.writeFile(skillMdPath, modifiedContent, 'utf-8')
      await fs.promises.writeFile(
        path.join(getAgentSkillsDir(agentSlug), skillDirName, '.skillset-original.md'),
        modifiedContent,
        'utf-8',
      )
    }
    await writeJsonFile(getSkillMetadataPath(agentSlug, skillDirName), meta)

    return { prUrl: `platform:${result.status}` }
  }

  // GitHub provider: existing fork + PR flow
  const repoDir = getSkillsetRepoDir(meta.skillsetId)
  const ctx = await prepareForkBranch(repoDir, `update-${skillDirName}`)

  // Copy the modified file to the repo and stage it
  const destPath = path.join(repoDir, meta.skillPath)
  await fs.promises.writeFile(destPath, modifiedContent, 'utf-8')

  await execFileAsync('git', ['add', meta.skillPath], {
    cwd: repoDir, timeout: 10000, env: GIT_ENV,
  })

  await execFileAsync(
    'git',
    ['commit', '-m', options.title],
    { cwd: repoDir, timeout: 10000, env: GIT_ENV }
  )

  const prUrl = await pushAndCreatePR(ctx, options)

  // Save the PR URL in metadata so the UI can show it
  const metadataPath = getSkillMetadataPath(agentSlug, skillDirName)
  meta.openPrUrl = prUrl
  await fs.promises.writeFile(metadataPath, JSON.stringify(meta, null, 2), 'utf-8')

  return { prUrl }
}

/**
 * Update the version in SKILL.md frontmatter metadata.
 */
function updateFrontmatterVersion(content: string, newVersion: string): string {
  const match = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
  if (!match) {
    return content
  }

  let frontmatter = match[2]

  // Try to replace existing version in metadata section
  if (/^\s*version:/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(
      /^(\s*version:\s*).+$/m,
      `$1${newVersion}`
    )
  } else {
    frontmatter = frontmatter.trimEnd() + `\nversion: ${newVersion}`
  }

  return match[1] + frontmatter + match[3] + content.slice(match[0].length)
}

// ============================================================================
// Publish Local Skill to Skillset
// ============================================================================

/**
 * Generate AI-powered PR suggestions for publishing a new skill.
 * Unlike generatePRSuggestions (which diffs original vs modified), this
 * summarizes the skill content itself for a "new skill" PR.
 */
async function generatePublishSuggestions(
  skillContent: string,
  skillName: string,
): Promise<{ suggestedTitle: string; suggestedBody: string; suggestedVersion: string }> {
  const frontmatter = parseSkillFrontmatter(skillContent)
  const currentVersion = frontmatter.version || '1.0.0'

  const fallback = {
    suggestedTitle: `Add ${skillName} skill`,
    suggestedBody: `Adds the ${skillName} skill.`,
    suggestedVersion: currentVersion,
  }

  const provider = getActiveLlmProvider()
  if (!provider.getApiKeyStatus().isConfigured) {
    console.warn('[Publish suggestions] No LLM API key configured')
    return fallback
  }

  try {
    const client = provider.createClient()
    const model = getEffectiveModels().summarizerModel

    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: `You are reviewing a new skill definition file (SKILL.md) that is being submitted to a shared skillset repository. Generate a PR title, description, and confirm the version.

Skill name: ${skillName}

SKILL.md content:
\`\`\`
${skillContent}
\`\`\`

Generate:
- A concise, imperative PR title (e.g. "Add NDA review skill")
- A markdown description explaining what the skill does and its key capabilities
- The version to use (use the version from the skill's metadata if present, otherwise "1.0.0")`,
          },
        ],
        output_config: {
          format: {
            type: 'json_schema' as const,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Concise imperative PR title' },
                body: { type: 'string', description: 'Markdown description of the skill' },
                version: { type: 'string', description: 'SemVer version for the skill' },
              },
              required: ['title', 'body', 'version'],
              additionalProperties: false,
            },
          },
        },
      })
    )

    const textBlock = response.content.find((block) => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') return fallback

    const parsed = JSON.parse(textBlock.text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch (error) {
    console.error('Failed to generate publish suggestions via AI:', error)
    return fallback
  }
}

/**
 * Get metadata needed to prepare a publish dialog for a local skill.
 */
export async function getSkillPublishInfo(
  agentSlug: string,
  skillDirName: string,
  skillsetConfig: SkillsetConfig,
): Promise<{
  skillName: string
  skillsetUrl: string
  skillsetName: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}> {
  sanitizeDirName(skillDirName)

  // Verify skill exists and is local (no metadata)
  const meta = await getInstalledSkillMetadata(agentSlug, skillDirName)
  if (meta) {
    throw new Error('Skill already belongs to a skillset — use Open PR instead')
  }

  const skillMdPath = path.join(getAgentSkillsDir(agentSlug), skillDirName, 'SKILL.md')
  const skillContent = await readFileOrNull(skillMdPath)
  if (!skillContent) {
    throw new Error('SKILL.md not found')
  }

  await ensureGhAuthenticated()

  const skillName = getDisplayName(skillDirName)
  const suggestions = await generatePublishSuggestions(skillContent, skillName)

  return {
    skillName,
    skillsetUrl: skillsetConfig.url,
    skillsetName: skillsetConfig.name,
    ...suggestions,
  }
}

/**
 * Publish a local skill to a skillset repository via PR.
 * Creates a PR that adds the SKILL.md and updates index.json.
 */
export async function publishSkillToSkillset(
  agentSlug: string,
  skillDirName: string,
  skillsetConfig: SkillsetConfig,
  options: {
    title: string
    body: string
    newVersion?: string
  },
): Promise<{ prUrl: string }> {
  sanitizeDirName(skillDirName)

  // Read the local SKILL.md
  const skillMdPath = path.join(getAgentSkillsDir(agentSlug), skillDirName, 'SKILL.md')
  let skillContent = await readFileOrNull(skillMdPath)
  if (!skillContent) {
    throw new Error('SKILL.md not found')
  }

  // If a version was specified, update the frontmatter
  if (options.newVersion) {
    skillContent = updateFrontmatterVersion(skillContent, options.newVersion)
  }

  const frontmatter = parseSkillFrontmatter(skillContent)
  const version = options.newVersion || frontmatter.version || '1.0.0'
  const skillName = getDisplayName(skillDirName)
  const description = parseDescription(skillContent)
  const skillPathInRepo = `skills/${skillDirName}/SKILL.md`

  // Platform provider: submit via proxy API instead of fork+PR
  if (skillsetConfig.provider === 'platform') {
    const result = await submitSkillToPlatform(
      {
        skillsetId: skillsetConfig.id,
        skillsetUrl: skillsetConfig.url,
        skillName,
        skillPath: skillPathInRepo,
        installedVersion: version,
        installedAt: new Date().toISOString(),
        originalContentHash: contentHash(skillContent),
        provider: 'platform',
        platformRepoId: skillsetConfig.platformRepoId,
        skillsetName: skillsetConfig.name,
      },
      [{ path: skillPathInRepo, content: skillContent }],
      options.title,
      options.body,
    )

    const metadata: InstalledSkillMetadata = {
      skillsetId: skillsetConfig.id,
      skillsetUrl: skillsetConfig.url,
      skillName,
      skillPath: skillPathInRepo,
      installedVersion: version,
      installedAt: new Date().toISOString(),
      originalContentHash: contentHash(skillContent),
      provider: 'platform',
      platformRepoId: skillsetConfig.platformRepoId,
      skillsetName: skillsetConfig.name,
    }

    if (result.queueItem?.id && result.status !== 'merged') {
      metadata.pendingQueueItemId = result.queueItem.id
    } else if (result.status === 'merged') {
      metadata.originalContentHash = contentHash(skillContent)
      await fs.promises.writeFile(skillMdPath, skillContent, 'utf-8')
    }

    await writeJsonFile(getSkillMetadataPath(agentSlug, skillDirName), metadata)

    await fs.promises.writeFile(
      path.join(getAgentSkillsDir(agentSlug), skillDirName, '.skillset-original.md'),
      skillContent,
      'utf-8'
    )

    return { prUrl: `platform:${result.status}` }
  }

  // GitHub provider: existing fork + PR flow
  // Ensure the skillset cache is available
  const repoDir = getSkillsetRepoDir(skillsetConfig.id)
  if (!(await isGitRepo(repoDir))) {
    await ensureSkillsetCached(skillsetConfig.id, skillsetConfig.url, skillsetConfig.provider, undefined, skillsetConfig.name)
  }

  const ctx = await prepareForkBranch(repoDir, `add-${skillDirName}`)

  // Check for naming conflict — abort if a skill already exists at this path
  const index = await readIndexJson(repoDir)
  const conflict = index.skills.find(
    (s) => s.path === skillPathInRepo
  )
  if (conflict) {
    // Clean up the branch before throwing
    await execFileAsync('git', ['checkout', ctx.baseBranch], {
      cwd: repoDir, timeout: 10000, env: GIT_ENV,
    }).catch(() => { /* ignore */ })
    await execFileAsync('git', ['branch', '-D', ctx.branchName], {
      cwd: repoDir, timeout: 5000, env: GIT_ENV,
    }).catch(() => { /* ignore */ })
    throw new Error(
      `A skill already exists at "${conflict.path}" in this skillset. Choose a different name or use a different skillset.`
    )
  }

  // Create skill directory and write SKILL.md
  const destDir = path.join(repoDir, 'skills', skillDirName)
  await ensureDirectory(destDir)
  await fs.promises.writeFile(path.join(destDir, 'SKILL.md'), skillContent, 'utf-8')

  // Update index.json with the new skill entry
  index.skills.push({
    name: skillName,
    path: skillPathInRepo,
    description,
    version,
  })
  await fs.promises.writeFile(
    path.join(repoDir, 'index.json'),
    JSON.stringify(index, null, 2) + '\n',
    'utf-8'
  )

  // Stage both files and commit
  await execFileAsync('git', ['add', skillPathInRepo, 'index.json'], {
    cwd: repoDir, timeout: 10000, env: GIT_ENV,
  })

  await execFileAsync(
    'git',
    ['commit', '-m', options.title],
    { cwd: repoDir, timeout: 10000, env: GIT_ENV }
  )

  const prUrl = await pushAndCreatePR(ctx, options)

  // Write metadata so the skill is now tracked as belonging to this skillset
  const metadata: InstalledSkillMetadata = {
    skillsetId: skillsetConfig.id,
    skillsetUrl: skillsetConfig.url,
    skillName,
    skillPath: skillPathInRepo,
    installedVersion: version,
    installedAt: new Date().toISOString(),
    originalContentHash: contentHash(skillContent),
    openPrUrl: prUrl,
  }

  const metadataPath = getSkillMetadataPath(agentSlug, skillDirName)
  await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8')

  // Store original content for future diffs
  await fs.promises.writeFile(
    path.join(getAgentSkillsDir(agentSlug), skillDirName, '.skillset-original.md'),
    skillContent,
    'utf-8'
  )

  return { prUrl }
}

export { copyDirectoryFiltered as copyDirectory } from '@shared/lib/utils/skillset-helpers'
