/**
 * Agent Template Service
 *
 * Handles exporting/importing agents as ZIP templates and
 * managing agents from skillset repositories (install, update, publish, PR).
 */

import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import archiver from 'archiver'
import AdmZip from 'adm-zip'
import {
  getAgentWorkspaceDir,
  getAgentClaudeMdPath,
  readFileOrNull,
  ensureDirectory,
  directoryExists,
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
} from '@shared/lib/utils/file-storage'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { getConfiguredLlmClient, extractTextFromLlmResponse } from '@shared/lib/llm-provider/helpers'
import { withRetry } from '@shared/lib/utils/retry'
import {
  readIndexJson,
  ensureSkillsetCached,
  getSkillsetIndex,
  getSkillsetRepoDir,
  refreshSkillset,
  parseSkillFrontmatter,
} from '@shared/lib/services/skillset-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import { createAgentFromExistingWorkspace, getAgentWithStatus, listAgents } from '@shared/lib/services/agent-service'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import type {
  SkillsetConfig,
  InstalledAgentMetadata,
  AgentTemplateStatus,
  DiscoverableAgent,
  RequiredEnvVar,
  SkillProvider,
} from '@shared/lib/types/skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentFrontmatter } from '@shared/lib/types/agent'
import {
  copyDirectoryFiltered,
  writeJsonFile,
} from '@shared/lib/utils/file-storage'

// ============================================================================
// Constants
// ============================================================================

const MAX_UNCOMPRESSED_SIZE = 200 * 1024 * 1024 // 200MB
const MAX_FILE_COUNT = 2000

/** Files/dirs excluded from templates (matched by name at any level) */
const TEMPLATE_EXCLUDE = new Set([
  '.env',
  '.DS_Store',
  'node_modules',
  '__pycache__',
  'session-metadata.json',
  '.superagent-sessions.json',
  '.skillset-agent-metadata.json',
])

/** File extensions excluded from templates at any level */
const TEMPLATE_EXCLUDE_EXTENSIONS = new Set([
  '.pyc',
])

/** Dirs/files excluded from full exports (matched by name at any level) */
const FULL_EXPORT_EXCLUDE = new Set([
  '.DS_Store',
  'node_modules',
  '__pycache__',
  '.browser-profile',
])

/** Top-level directories excluded from templates entirely */
const TEMPLATE_EXCLUDE_TOP_DIRS = new Set([
  'uploads',
  'downloads',
  '.browser-profile',
])

/**
 * Inside .claude/, only these subdirectories are included in templates.
 * Everything else (.claude/projects, .claude/debug, .claude/todos,
 * .claude/.claude.json, .claude/stats-cache.json, etc.) is excluded.
 */
const CLAUDE_DIR_ALLOWLIST = new Set([
  'skills',
])


// ============================================================================
// Metadata Path Helpers
// ============================================================================

function getAgentMetadataPath(agentSlug: string): string {
  return path.join(getAgentWorkspaceDir(agentSlug), '.skillset-agent-metadata.json')
}

type SkillsetRef = {
  skillsetId: string
  skillsetUrl: string
  provider?: SkillProvider
  skillsetName?: string
  providerData?: SkillsetConfig['providerData']
}

function toSkillsetRefFromConfig(config: Pick<SkillsetConfig, 'id' | 'url' | 'name' | 'provider' | 'providerData'>): SkillsetRef {
  const provider = getSkillsetProvider(config.provider)
  return {
    skillsetId: config.id,
    skillsetUrl: config.url,
    provider: config.provider,
    skillsetName: config.name,
    providerData: provider.normalizeProviderData(config),
  }
}

function toSkillsetRefFromMeta(
  meta: Pick<InstalledAgentMetadata, 'skillsetId' | 'skillsetUrl' | 'skillsetName' | 'provider' | 'providerData'>,
): SkillsetRef {
  const provider = getSkillsetProvider(meta.provider)
  return {
    skillsetId: meta.skillsetId,
    skillsetUrl: meta.skillsetUrl,
    provider: meta.provider,
    skillsetName: meta.skillsetName,
    providerData: provider.normalizeProviderData(meta),
  }
}

function getSkillsetRepoDirForRef(ref: Pick<SkillsetRef, 'skillsetId' | 'provider' | 'providerData'>): string {
  const provider = getSkillsetProvider(ref.provider)
  return getSkillsetRepoDir(provider.getEffectiveRepoId(ref))
}

// ============================================================================
// Template File Walking
// ============================================================================

/**
 * Walk the agent workspace and return paths of all template-eligible files.
 * Paths are relative to the workspace directory.
 *
 * Inclusion rules:
 * - `CLAUDE.md` and other non-excluded root files are included
 * - `.claude/skills/**` is included
 * - Everything else under `.claude/` is excluded (debug, todos, projects, state files)
 * - `.browser-profile/`, `uploads/` are excluded entirely
 * - `.DS_Store`, `.env`, session files are excluded at any level
 */
async function walkTemplateFiles(workspaceDir: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string, relativeBase: string, depth: number): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const relativePath = path.join(relativeBase, entry.name)

      // Skip excluded files at any level
      if (TEMPLATE_EXCLUDE.has(entry.name)) continue

      if (entry.isDirectory()) {
        // Skip top-level excluded directories
        if (depth === 0 && TEMPLATE_EXCLUDE_TOP_DIRS.has(entry.name)) continue

        // For .claude/ directory, only recurse into allowlisted subdirs
        if (depth === 0 && entry.name === '.claude') {
          // Walk .claude/ but only include allowlisted subdirectories
          await walkClaudeDir(path.join(dir, entry.name), '.claude')
          continue
        }

        await walk(path.join(dir, entry.name), relativePath, depth + 1)
      } else {
        if (!TEMPLATE_EXCLUDE_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(relativePath)
        }
      }
    }
  }

  async function walkClaudeDir(claudeDir: string, relativeBase: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(claudeDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (TEMPLATE_EXCLUDE.has(entry.name)) continue

      if (entry.isDirectory()) {
        // Only recurse into allowlisted subdirectories of .claude/
        if (!CLAUDE_DIR_ALLOWLIST.has(entry.name)) continue
        const relativePath = path.join(relativeBase, entry.name)
        await walk(path.join(claudeDir, entry.name), relativePath, 2)
      }
      // Skip files directly in .claude/ (e.g., .claude.json, stats-cache.json, backups)
    }
  }

  await walk(workspaceDir, '', 0)
  return files
}

/**
 * Walk the agent workspace for a full export, returning all file paths.
 * Uses explicit walking instead of archive.glob() to avoid hangs on Windows
 * caused by broken symlinks and permission issues with readdir-glob.
 */
async function walkFullExportFiles(workspaceDir: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string, relativeBase: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return // skip directories we can't read
    }

    for (const entry of entries) {
      if (FULL_EXPORT_EXCLUDE.has(entry.name)) continue

      const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name

      // Skip symlinks — they may be broken or point outside the workspace
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relativePath)
      } else if (entry.isFile()) {
        files.push(relativePath)
      }
    }
  }

  await walk(workspaceDir, '')
  return files
}

// ============================================================================
// ZIP Export
// ============================================================================

/**
 * Export an agent's workspace as a ZIP template buffer.
 */
export async function exportAgentTemplate(agentSlug: string): Promise<Buffer> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)

  if (!(await directoryExists(workspaceDir))) {
    throw new Error('Agent workspace not found')
  }

  const claudeMdPath = getAgentClaudeMdPath(agentSlug)
  const claudeMdContent = await readFileOrNull(claudeMdPath)
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found in agent workspace')
  }

  const templateFiles = await walkTemplateFiles(workspaceDir)

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const chunks: Buffer[] = []

    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.on('error', reject)

    for (const relativePath of templateFiles) {
      const fullPath = path.join(workspaceDir, relativePath)
      archive.file(fullPath, { name: relativePath })
    }

    archive.finalize()
  })
}

/**
 * Export a full agent workspace as a ZIP buffer (includes .env, sessions, etc).
 * Used for migrating agents between machines.
 */
export async function exportAgentFull(agentSlug: string): Promise<Buffer> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)

  if (!(await directoryExists(workspaceDir))) {
    throw new Error('Agent workspace not found')
  }

  const fullFiles = await walkFullExportFiles(workspaceDir)

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const chunks: Buffer[] = []

    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.on('error', reject)

    for (const relativePath of fullFiles) {
      const fullPath = path.join(workspaceDir, relativePath)
      archive.file(fullPath, { name: relativePath })
    }

    archive.finalize()
  })
}

// ============================================================================
// ZIP Helpers
// ============================================================================

/**
 * Detect a common wrapper directory prefix in ZIP entries.
 * Many ZIP tools (macOS Finder, etc.) wrap all files in a top-level directory.
 * Returns the prefix to strip (e.g., "Legal Agent-template/") or empty string.
 * Also filters out __MACOSX resource fork entries.
 */
function detectZipPrefix(entries: AdmZip.IZipEntry[]): string {
  // Filter out macOS resource fork entries and directories
  const fileEntries = entries.filter(
    (e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX/')
  )

  if (fileEntries.length === 0) return ''

  // Check if all files share a common first path segment
  const firstSegments = new Set<string>()
  for (const entry of fileEntries) {
    const slashIdx = entry.entryName.indexOf('/')
    if (slashIdx === -1) {
      // File at root level - no common prefix
      return ''
    }
    firstSegments.add(entry.entryName.substring(0, slashIdx + 1))
  }

  // If all files share exactly one common prefix directory, use it
  if (firstSegments.size === 1) {
    return firstSegments.values().next().value!
  }

  return ''
}

// ============================================================================
// ZIP Validation
// ============================================================================

export interface TemplateValidationResult {
  valid: boolean
  error?: string
  agentName?: string
  fileCount: number
  /** Detected wrapper directory prefix to strip during import */
  stripPrefix: string
}

/**
 * Validate a ZIP buffer as an agent template.
 * Handles ZIPs with or without a wrapper directory (e.g., from macOS Finder).
 * In 'full' mode, only __MACOSX entries are filtered — all other entries count
 * toward size/count limits and are checked for path traversal.
 */
export function validateAgentTemplate(zipBuffer: Buffer, mode: 'template' | 'full' = 'template'): TemplateValidationResult {
  try {
    const zip = new AdmZip(zipBuffer)
    const entries = zip.getEntries()

    // Filter out macOS resource fork entries; in template mode also filter excluded files
    const realEntries = entries.filter((e) => {
      if (e.entryName.startsWith('__MACOSX/')) return false
      if (mode === 'template') {
        const parts = e.entryName.split('/')
        if (parts.some((p) => TEMPLATE_EXCLUDE.has(p))) return false
        if (!e.isDirectory && TEMPLATE_EXCLUDE_EXTENSIONS.has(path.extname(e.entryName))) return false
      }
      return true
    })

    // Check file count
    if (realEntries.length > MAX_FILE_COUNT) {
      return { valid: false, error: `Too many files (${realEntries.length}, max ${MAX_FILE_COUNT})`, fileCount: realEntries.length, stripPrefix: '' }
    }

    // Check total uncompressed size
    let totalSize = 0
    for (const entry of realEntries) {
      totalSize += entry.header.size
      if (totalSize > MAX_UNCOMPRESSED_SIZE) {
        return { valid: false, error: `Template too large (exceeds ${MAX_UNCOMPRESSED_SIZE / 1024 / 1024}MB)`, fileCount: realEntries.length, stripPrefix: '' }
      }
    }

    // Path traversal check
    for (const entry of realEntries) {
      const name = entry.entryName
      if (name.includes('..') || path.isAbsolute(name)) {
        return { valid: false, error: `Invalid path in template: ${name}`, fileCount: realEntries.length, stripPrefix: '' }
      }
    }

    // Detect wrapper directory prefix
    const stripPrefix = detectZipPrefix(entries)

    // Check CLAUDE.md exists (with or without prefix)
    const claudeMdEntry = realEntries.find(
      (e) => {
        const name = stripPrefix ? e.entryName.replace(stripPrefix, '') : e.entryName
        const normalized = name.replace(/^\.\//, '')
        return normalized === 'CLAUDE.md'
      }
    )
    if (!claudeMdEntry) {
      return { valid: false, error: 'CLAUDE.md not found in template', fileCount: realEntries.length, stripPrefix }
    }

    // Parse name from frontmatter
    const claudeMdContent = claudeMdEntry.getData().toString('utf-8')
    const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
    const agentName = frontmatter.name || undefined

    return { valid: true, agentName, fileCount: realEntries.length, stripPrefix }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Failed to read ZIP file',
      fileCount: 0,
      stripPrefix: '',
    }
  }
}

// ============================================================================
// ZIP Import
// ============================================================================

/**
 * Import an agent from a ZIP template buffer.
 * Creates a new agent with the template contents.
 */
export async function importAgentFromTemplate(
  zipBuffer: Buffer,
  nameOverride?: string,
  mode: 'template' | 'full' = 'template',
): Promise<ApiAgent> {
  const validation = validateAgentTemplate(zipBuffer, mode)
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid template')
  }

  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()

  // If name override is provided, we need to update the CLAUDE.md frontmatter
  const effectiveName = nameOverride?.trim() || validation.agentName

  // Create the agent from workspace first to get a slug
  // We need a temp approach: extract to a temp dir, then use createAgentFromExistingWorkspace
  const agent = await createAgentFromExistingWorkspace(effectiveName || 'Imported Agent')
  const workspaceDir = getAgentWorkspaceDir(agent.slug)

  // Extract files to the workspace, skipping secrets and macOS junk
  const stripPrefix = validation.stripPrefix
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (entry.entryName.startsWith('__MACOSX/')) continue

    // Strip wrapper directory prefix and normalize
    let entryName = stripPrefix
      ? entry.entryName.replace(stripPrefix, '')
      : entry.entryName
    entryName = entryName.replace(/^\.\//, '')

    if (!entryName) continue

    if (mode === 'template') {
      // Skip excluded directories (node_modules, __pycache__, etc.) and extensions (.pyc)
      const entryParts = entry.entryName.split('/')
      if (entryParts.some((p) => TEMPLATE_EXCLUDE.has(p))) continue
      if (TEMPLATE_EXCLUDE_EXTENSIONS.has(path.extname(entry.entryName))) continue

      // Security: skip secrets and excluded files even if present
      const baseName = path.basename(entryName)
      if (baseName === '.env' || baseName === 'session-metadata.json') continue
    }

    // Path traversal protection
    const destPath = path.resolve(workspaceDir, entryName)
    if (!destPath.startsWith(workspaceDir)) continue

    await ensureDirectory(path.dirname(destPath))
    await fs.promises.writeFile(destPath, entry.getData())
  }

  // If name override was specified, update the CLAUDE.md
  if (nameOverride?.trim()) {
    const claudeMdPath = getAgentClaudeMdPath(agent.slug)
    let content = await readFileOrNull(claudeMdPath)
    if (content) {
      // Replace name in frontmatter
      content = content.replace(
        /^(---\s*\n[\s\S]*?)(name:\s*).+$/m,
        `$1$2${nameOverride.trim()}`
      )
      await fs.promises.writeFile(claudeMdPath, content, 'utf-8')
    }
  }

  // Re-read the agent to get updated info
  const result = await getAgentWithStatus(agent.slug)
  return result || agent
}

// ============================================================================
// Skillset Integration - Install
// ============================================================================

/**
 * Install an agent from a skillset repository.
 * Copies the agent template directory into a new agent workspace.
 */
export async function installAgentFromSkillset(
  skillsetRef: SkillsetRef,
  agentPath: string,
  agentName: string,
  agentVersion: string,
): Promise<ApiAgent> {
  const repoDir = getSkillsetRepoDirForRef(skillsetRef)
  if (!(await directoryExists(path.join(repoDir, '.git')))) {
    await ensureSkillsetCached(skillsetRef)
  }

  // The agent path in the repo (e.g., "agents/research-assistant/")
  const agentDirInRepo = path.join(repoDir, agentPath.replace(/\/$/, ''))

  if (!(await directoryExists(agentDirInRepo))) {
    throw new Error(`Agent directory not found in skillset: ${agentPath}`)
  }

  // Create a new agent
  const agent = await createAgentFromExistingWorkspace(agentName)
  const workspaceDir = getAgentWorkspaceDir(agent.slug)

  // Copy template files from repo to workspace
  await copyDirectoryFiltered(agentDirInRepo, workspaceDir)

  // Compute hash of template files
  const hash = await computeAgentTemplateHash(workspaceDir)

  // Write agent metadata
  const metadata: InstalledAgentMetadata = {
    skillsetId: skillsetRef.skillsetId,
    skillsetUrl: skillsetRef.skillsetUrl,
    agentName,
    agentPath,
    installedVersion: agentVersion,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    provider: skillsetRef.provider,
    providerData: skillsetRef.providerData,
    skillsetName: skillsetRef.skillsetName,
  }

  await fs.promises.writeFile(
    getAgentMetadataPath(agent.slug),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  )

  // Re-read the agent
  const result = await getAgentWithStatus(agent.slug)
  return result || agent
}

// ============================================================================
// Skillset Integration - Update
// ============================================================================

/**
 * Update an installed agent from its skillset.
 * Re-copies template files, preserving .env, sessions, and uploads.
 */
export async function updateAgentFromSkillset(
  agentSlug: string,
): Promise<{ updated: boolean }> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    return { updated: false }
  }

  const skillsetRef = toSkillsetRefFromMeta(meta)

  await refreshSkillset(skillsetRef)

  // Re-read the index to get the latest version
  const index = await getSkillsetIndex(skillsetRef)
  if (!index || !index.agents) return { updated: false }

  const agentEntry = index.agents.find((a) => a.path === meta.agentPath)
  if (!agentEntry) return { updated: false }

  const repoDir = getSkillsetRepoDirForRef(skillsetRef)
  const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))

  if (!(await directoryExists(agentDirInRepo))) {
    return { updated: false }
  }

  const workspaceDir = getAgentWorkspaceDir(agentSlug)

  // Walk the template source and copy files, preserving .env/session-metadata
  await copyTemplateFiles(agentDirInRepo, workspaceDir)

  // Recompute hash
  const hash = await computeAgentTemplateHash(workspaceDir)

  // Update metadata
  const updatedMeta: InstalledAgentMetadata = {
    ...meta,
    installedVersion: agentEntry.version,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    openPrUrl: undefined,
  }

  await fs.promises.writeFile(
    getAgentMetadataPath(agentSlug),
    JSON.stringify(updatedMeta, null, 2),
    'utf-8'
  )

  return { updated: true }
}

async function copyTemplateFiles(src: string, dest: string): Promise<void> {
  return copyDirectoryFiltered(src, dest, ['.skillset-agent-metadata.json'])
}

// ============================================================================
// Metadata & Status
// ============================================================================

/**
 * Read installed agent metadata from .skillset-agent-metadata.json.
 */
export async function getInstalledAgentMetadata(
  agentSlug: string,
): Promise<InstalledAgentMetadata | null> {
  const metadataPath = getAgentMetadataPath(agentSlug)
  const content = await readFileOrNull(metadataPath)
  if (!content) return null

  try {
    return JSON.parse(content) as InstalledAgentMetadata
  } catch {
    return null
  }
}

/**
 * Check if an agent has an onboarding skill (`.claude/skills/agent-onboarding/SKILL.md`).
 */
export async function hasOnboardingSkill(agentSlug: string): Promise<boolean> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const onboardingPath = path.join(workspaceDir, '.claude', 'skills', 'agent-onboarding', 'SKILL.md')
  try {
    await fs.promises.access(onboardingPath)
    return true
  } catch {
    return false
  }
}

/**
 * Scan all skills in an agent workspace and collect required_env_vars from SKILL.md frontmatter.
 * De-duplicates by env var name.
 */
export async function collectAgentRequiredEnvVars(
  agentSlug: string,
  options?: { excludeExistingSecrets?: boolean },
): Promise<RequiredEnvVar[]> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const skillsDir = path.join(workspaceDir, '.claude', 'skills')

  try {
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    const allEnvVars = new Map<string, RequiredEnvVar>()

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md')
      const content = await readFileOrNull(skillMdPath)
      if (!content) continue

      const frontmatter = parseSkillFrontmatter(content)
      if (frontmatter.required_env_vars) {
        for (const envVar of frontmatter.required_env_vars) {
          allEnvVars.set(envVar.name, envVar)
        }
      }
    }

    let requiredEnvVars = Array.from(allEnvVars.values())

    if (options?.excludeExistingSecrets) {
      const existingEnvVars = new Set(await getSecretEnvVars(agentSlug))
      requiredEnvVars = requiredEnvVars.filter((envVar) => !existingEnvVars.has(envVar.name))
    }

    return requiredEnvVars
  } catch {
    return []
  }
}

/**
 * Get the template status of an agent.
 */
export async function getAgentTemplateStatus(
  agentSlug: string,
  skillsets: SkillsetConfig[],
  options?: {
    currentContext?: Record<string, unknown>
  },
): Promise<AgentTemplateStatus> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    return { type: 'local' }
  }

  const skillsetConfig = skillsets.find((s) => s.id === meta.skillsetId)
  const metaRef = toSkillsetRefFromMeta(meta)
  const configRef = skillsetConfig ? toSkillsetRefFromConfig(skillsetConfig) : undefined
  const hostingProvider = getSkillsetProvider(meta.provider)
  const {
    skillsetName,
    sourceLabel,
    isAccessible,
  } = hostingProvider.getAccessInfo({
    currentContext: options?.currentContext,
    config: skillsetConfig ? {
      name: skillsetConfig.name,
      description: skillsetConfig.description,
      providerData: configRef?.providerData,
    } : undefined,
    meta: metaRef,
  })
  if (!isAccessible) {
    return {
      type: 'local',
      skillsetId: meta.skillsetId,
      skillsetName,
      sourceLabel,
      publishable: false,
    }
  }
  const workspaceDir = getAgentWorkspaceDir(agentSlug)

  if (meta.pendingQueueItemId) {
    const queueStatus = await hostingProvider.getQueueItemStatus(meta.pendingQueueItemId)
    if (queueStatus === 'merged' || queueStatus === 'rejected') {
      if (queueStatus === 'merged') {
        try {
          await refreshSkillset(metaRef)
        } catch { /* best-effort pull */ }

        const repoDir = getSkillsetRepoDirForRef(configRef ?? metaRef)
        const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
        if (await directoryExists(agentDirInRepo)) {
          await copyTemplateFiles(agentDirInRepo, workspaceDir)
          meta.originalContentHash = await computeAgentTemplateHash(workspaceDir)
        }
      }
      meta.pendingQueueItemId = undefined
      await writeJsonFile(getAgentMetadataPath(agentSlug), meta)
    }
  }

  // Determine status: locally modified > open PR > update available > up to date
  const currentHash = await computeAgentTemplateHash(workspaceDir)

  if (currentHash !== meta.originalContentHash || meta.openPrUrl) {
    return { type: 'locally_modified', skillsetId: meta.skillsetId, skillsetName, sourceLabel, openPrUrl: meta.openPrUrl }
  }

  // Check for updates: version bump in index.json OR file content change in the remote cache
  const index = await getSkillsetIndex(metaRef)
  const agentEntry = index?.agents?.find((a) => a.path === meta.agentPath)
  const versionChanged = !!(agentEntry && agentEntry.version !== meta.installedVersion)

  // Also compare remote cache hash — catches edits where version was not bumped
  const repoDir = getSkillsetRepoDirForRef(configRef ?? metaRef)
  const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
  let contentChanged = false
  if (await directoryExists(agentDirInRepo)) {
    const remoteCacheHash = await computeAgentTemplateHash(agentDirInRepo)
    contentChanged = remoteCacheHash !== meta.originalContentHash
  }

  if (versionChanged || contentChanged) {
    return {
      type: 'update_available',
      skillsetId: meta.skillsetId,
      skillsetName,
      sourceLabel,
      latestVersion: versionChanged ? agentEntry!.version : undefined,
    }
  }

  return { type: 'up_to_date', skillsetId: meta.skillsetId, skillsetName, sourceLabel }
}

/**
 * Compute SHA-256 hash of all template-eligible files in a workspace.
 */
export async function computeAgentTemplateHash(workspaceDir: string): Promise<string> {
  const files = await walkTemplateFiles(workspaceDir)
  files.sort() // Ensure deterministic order

  const hash = crypto.createHash('sha256')

  for (const relativePath of files) {
    const fullPath = path.join(workspaceDir, relativePath)
    try {
      const content = await fs.promises.readFile(fullPath, 'utf-8')
      hash.update(relativePath)
      hash.update(content)
    } catch {
      // Skip unreadable files
    }
  }

  return hash.digest('hex')
}

function updateAgentFrontmatterVersion(content: string, newVersion: string): string {
  const parsed = parseMarkdownWithFrontmatter<Record<string, unknown>>(content)
  return serializeMarkdownWithFrontmatter(
    { ...parsed.frontmatter, version: newVersion },
    parsed.body
  )
}

async function collectAgentFilesForPlatform(
  workspaceDir: string,
  agentPathInRepo: string,
  options?: { claudeMdContent?: string },
): Promise<Array<{ path: string; content: string }>> {
  const templateFiles = await walkTemplateFiles(workspaceDir)
  const normalizedRoot = agentPathInRepo.replace(/\/$/, '')

  return await Promise.all(templateFiles.map(async (relativePath) => {
    const repoPath = `${normalizedRoot}/${relativePath.replace(/\\/g, '/')}`
    if (relativePath === 'CLAUDE.md' && options?.claudeMdContent !== undefined) {
      return { path: repoPath, content: options.claudeMdContent }
    }

    const fullPath = path.join(workspaceDir, relativePath)
    const content = await fs.promises.readFile(fullPath, 'utf-8')
    return { path: repoPath, content }
  }))
}

// ============================================================================
// Discoverable Agents
// ============================================================================

/**
 * Get all agents from configured skillsets.
 * Reads from local cache only (fast). Use refreshSkillsetCaches() to update caches first.
 */
export async function getDiscoverableAgents(
  skillsets: SkillsetConfig[],
): Promise<DiscoverableAgent[]> {
  const discoverable: DiscoverableAgent[] = []

  for (const ss of skillsets) {
    const index = await getSkillsetIndex(toSkillsetRefFromConfig(ss))
    if (!index || !index.agents) continue

    for (const agent of index.agents) {
      discoverable.push({
        skillsetId: ss.id,
        skillsetName: ss.name,
        name: agent.name,
        description: agent.description,
        version: agent.version,
        path: agent.path,
      })
    }
  }

  return discoverable.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Refresh all skillset caches (git pull). Returns when complete.
 */
export async function refreshSkillsetCaches(
  skillsets: SkillsetConfig[],
): Promise<void> {
  await Promise.all(
    skillsets.map(async (ss) => {
      const ssRef = toSkillsetRefFromConfig(ss)
      try {
        await ensureSkillsetCached(ssRef)
        await refreshSkillset(ssRef)
      } catch {
        // Skip failed skillsets
      }
    })
  )
}

// ============================================================================
// Refresh
// ============================================================================

/**
 * Refresh all skillset caches and reconcile agent template status.
 */
export async function refreshAgentTemplates(
  skillsets: SkillsetConfig[],
): Promise<void> {
  // Refresh all skillset caches
  for (const ss of skillsets) {
    try {
      await refreshSkillset(toSkillsetRefFromConfig(ss))
    } catch (error) {
      console.warn(`Failed to refresh skillset ${ss.id}:`, error)
    }
  }

  // Reconcile installed agents
  const agents = await listAgents()

  for (const agent of agents) {
    const meta = await getInstalledAgentMetadata(agent.slug)
    if (!meta) continue

    const workspaceDir = getAgentWorkspaceDir(agent.slug)
    const currentHash = await computeAgentTemplateHash(workspaceDir)

    const repoDir = getSkillsetRepoDirForRef(toSkillsetRefFromMeta(meta))
    const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
    if (!(await directoryExists(agentDirInRepo))) continue

    const repoHash = await computeAgentTemplateHash(agentDirInRepo)

    // Local matches remote — clear any stale PR link
    if (repoHash === currentHash) {
      if (meta.openPrUrl || currentHash !== meta.originalContentHash) {
        meta.originalContentHash = currentHash
        meta.openPrUrl = undefined
        await writeJsonFile(getAgentMetadataPath(agent.slug), meta)
      }
      continue
    }

    // Remote has moved forward (e.g. PR merged, possibly with version bump).
    // Overwrite local files with the merged remote content so the template
    // transitions cleanly to up_to_date instead of lingering as locally_modified.
    // Only trigger when the local content was actually modified (currentHash !== originalContentHash).
    // If currentHash === originalContentHash, the remote difference just means the PR hasn't merged yet.
    if (meta.openPrUrl && currentHash !== meta.originalContentHash && repoHash !== meta.originalContentHash) {
      await copyTemplateFiles(agentDirInRepo, workspaceDir)
      meta.originalContentHash = repoHash
      meta.openPrUrl = undefined

      try {
        const index = await readIndexJson(repoDir)
        const agentEntry = index.agents?.find((a: { path: string }) => a.path === meta.agentPath)
        if (agentEntry?.version) {
          meta.installedVersion = agentEntry.version
        }
      } catch { /* best-effort version update */ }

      await writeJsonFile(getAgentMetadataPath(agent.slug), meta)
    }
  }
}

// ============================================================================
// PR / Publish - AI Suggestions
// ============================================================================

async function generateAgentPRSuggestions(
  meta: InstalledAgentMetadata,
  agentSlug: string,
): Promise<{ suggestedTitle: string; suggestedBody: string; suggestedVersion: string }> {
  const fallback = {
    suggestedTitle: `Update ${meta.agentName} agent template`,
    suggestedBody: `Updated ${meta.agentName} agent template with local modifications.`,
    suggestedVersion: meta.installedVersion,
  }

  const claudeMdPath = getAgentClaudeMdPath(agentSlug)
  const modifiedContent = await readFileOrNull(claudeMdPath)
  if (!modifiedContent) return fallback

  let client
  try {
    client = getConfiguredLlmClient()
  } catch {
    return fallback
  }

  try {
    const model = getEffectiveModels().summarizerModel

    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: `You are analyzing changes to an agent template. The agent is named "${meta.agentName}" and has been locally modified. Generate a PR title, description, and new SemVer version.

Current version: ${meta.installedVersion}

Modified CLAUDE.md:
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

    const text = extractTextFromLlmResponse(response)
    if (!text) return fallback

    const parsed = JSON.parse(text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch {
    return fallback
  }
}

async function generateAgentPublishSuggestions(
  claudeMdContent: string,
  agentName: string,
): Promise<{ suggestedTitle: string; suggestedBody: string; suggestedVersion: string }> {
  const fallback = {
    suggestedTitle: `Add ${agentName} agent template`,
    suggestedBody: `Adds the ${agentName} agent template.`,
    suggestedVersion: '1.0.0',
  }

  let client
  try {
    client = getConfiguredLlmClient()
  } catch {
    return fallback
  }

  try {
    const model = getEffectiveModels().summarizerModel

    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: `You are reviewing a new agent template (CLAUDE.md) being submitted to a shared skillset repository. Generate a PR title, description, and version.

Agent name: ${agentName}

CLAUDE.md content:
\`\`\`
${claudeMdContent}
\`\`\`

Generate:
- A concise, imperative PR title (e.g. "Add research assistant agent")
- A markdown description explaining what the agent does and its key capabilities
- The version to use (default "1.0.0" for new agents)`,
          },
        ],
        output_config: {
          format: {
            type: 'json_schema' as const,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Concise imperative PR title' },
                body: { type: 'string', description: 'Markdown description of the agent' },
                version: { type: 'string', description: 'SemVer version' },
              },
              required: ['title', 'body', 'version'],
              additionalProperties: false,
            },
          },
        },
      })
    )

    const text = extractTextFromLlmResponse(response)
    if (!text) return fallback

    const parsed = JSON.parse(text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch {
    return fallback
  }
}

// ============================================================================
// PR Flow
// ============================================================================

/**
 * Get PR info with AI suggestions for a locally modified agent.
 */
export async function getAgentPRInfo(
  agentSlug: string,
): Promise<{
  agentName: string
  agentPath: string
  skillsetUrl: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    throw new Error('Agent has no skillset metadata - cannot create PR')
  }

  await getSkillsetProvider(meta.provider).ensurePublishPreconditions()

  const suggestions = await generateAgentPRSuggestions(meta, agentSlug)

  return {
    agentName: meta.agentName,
    agentPath: meta.agentPath,
    skillsetUrl: meta.skillsetUrl,
    ...suggestions,
  }
}

/**
 * Create a PR for local modifications to an agent template.
 */
export async function createAgentPR(
  agentSlug: string,
  options: { title: string; body: string; newVersion?: string },
): Promise<{ prUrl?: string; successMessage: string }> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    throw new Error('Agent has no skillset metadata - cannot create PR')
  }

  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const claudeMdPath = getAgentClaudeMdPath(agentSlug)
  const claudeMdContent = await readFileOrNull(claudeMdPath)
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }
  const nextClaudeMdContent = options.newVersion
    ? updateAgentFrontmatterVersion(claudeMdContent, options.newVersion)
    : claudeMdContent
  const targetName = path.basename(meta.agentPath.replace(/\/$/, ''))

  const metaRef = toSkillsetRefFromMeta(meta)
  const hostingProvider = getSkillsetProvider(meta.provider)
  const repoDir = getSkillsetRepoDirForRef(metaRef)

  const files = await collectAgentFilesForPlatform(workspaceDir, meta.agentPath, {
    claudeMdContent: nextClaudeMdContent,
  })

  if (options.newVersion) {
    const index = await readIndexJson(repoDir)
    if (index.agents) {
      const agentEntry = index.agents.find((a) => a.path === meta.agentPath)
      if (agentEntry) {
        agentEntry.version = options.newVersion
        files.push({ path: 'index.json', content: JSON.stringify(index, null, 2) + '\n' })
      }
    }
  }

  const result = await hostingProvider.publishUpdate({
    repoDir,
    branchPrefix: `update-agent-${agentSlug}`,
    files,
    title: options.title,
    body: options.body,
    skillsetId: meta.skillsetId,
    skillsetUrl: meta.skillsetUrl,
    skillsetName: metaRef.skillsetName,
    providerData: metaRef.providerData,
    targetName,
    targetType: 'agent',
    message: options.body,
  })

  if (result.queueItem?.id && result.status !== 'merged') {
    meta.pendingQueueItemId = result.queueItem.id
  } else if (result.status === 'merged') {
    await refreshSkillset(metaRef)
    const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
    if (await directoryExists(agentDirInRepo)) {
      await copyTemplateFiles(agentDirInRepo, workspaceDir)
    } else {
      await fs.promises.writeFile(claudeMdPath, nextClaudeMdContent, 'utf-8')
    }
    meta.originalContentHash = await computeAgentTemplateHash(workspaceDir)
    meta.pendingQueueItemId = undefined
  }

  if (result.prUrl) {
    meta.openPrUrl = result.prUrl
  }

  await writeJsonFile(getAgentMetadataPath(agentSlug), meta)
  return { prUrl: result.prUrl, successMessage: result.successMessage }
}

// ============================================================================
// Publish Flow
// ============================================================================

/**
 * Get publish info with AI suggestions for a local agent.
 */
export async function getAgentPublishInfo(
  agentSlug: string,
  skillsetConfig: SkillsetConfig,
): Promise<{
  agentName: string
  skillsetUrl: string
  skillsetName: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}> {
  // Verify agent is local (no metadata)
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (meta) {
    throw new Error('Agent already belongs to a skillset - use Open PR instead')
  }

  const claudeMdContent = await readFileOrNull(getAgentClaudeMdPath(agentSlug))
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }

  await getSkillsetProvider(skillsetConfig.provider).ensurePublishPreconditions()

  const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
  const agentName = frontmatter.name || agentSlug

  const suggestions = await generateAgentPublishSuggestions(claudeMdContent, agentName)

  return {
    agentName,
    skillsetUrl: skillsetConfig.url,
    skillsetName: skillsetConfig.name,
    ...suggestions,
  }
}

/**
 * Publish a local agent to a skillset repository via PR.
 */
export async function publishAgentToSkillset(
  agentSlug: string,
  skillsetConfig: SkillsetConfig,
  options: { title: string; body: string; newVersion?: string },
): Promise<{ prUrl?: string; successMessage: string }> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const claudeMdPath = getAgentClaudeMdPath(agentSlug)
  let claudeMdContent = await readFileOrNull(claudeMdPath)
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }

  if (options.newVersion) {
    claudeMdContent = updateAgentFrontmatterVersion(claudeMdContent, options.newVersion)
  }

  const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
  const agentName = frontmatter.name || agentSlug
  const description = frontmatter.description || ''
  const version = options.newVersion || '1.0.0'

  // Slugify the agent name for the path
  const agentDirName = agentSlug
  const agentPathInRepo = `agents/${agentDirName}/`

  const skillsetRef = toSkillsetRefFromConfig(skillsetConfig)
  const repoDir = getSkillsetRepoDirForRef(skillsetRef)
  if (!(await directoryExists(path.join(repoDir, '.git')))) {
    await ensureSkillsetCached(skillsetRef)
  }

  const index = await readIndexJson(repoDir)
  const agents = index.agents || []
  const conflict = agents.find((a) => a.path === agentPathInRepo)
  if (conflict) {
    throw new Error(
      `An agent already exists at "${agentPathInRepo}" in this skillset.`
    )
  }

  const hostingProvider = getSkillsetProvider(skillsetConfig.provider)

  // Prepare agent template files + updated index.json
  const files = await collectAgentFilesForPlatform(workspaceDir, agentPathInRepo, {
    claudeMdContent,
  })
  if (!index.agents) {
    index.agents = []
  }
  index.agents.push({ name: agentName, path: agentPathInRepo, description, version })
  files.push({ path: 'index.json', content: JSON.stringify(index, null, 2) + '\n' })

  const result = await hostingProvider.publishUpdate({
    repoDir,
    branchPrefix: `add-agent-${agentDirName}`,
    files,
    title: options.title,
    body: options.body,
    skillsetId: skillsetConfig.id,
    skillsetUrl: skillsetConfig.url,
    skillsetName: skillsetConfig.name,
    providerData: skillsetRef.providerData,
    targetName: agentDirName,
    targetType: 'agent',
    message: options.body,
  })

  const metadata: InstalledAgentMetadata = {
    skillsetId: skillsetConfig.id,
    skillsetUrl: skillsetConfig.url,
    agentName,
    agentPath: agentPathInRepo,
    installedVersion: version,
    installedAt: new Date().toISOString(),
    originalContentHash: await computeAgentTemplateHash(workspaceDir),
    provider: skillsetConfig.provider,
    providerData: skillsetRef.providerData,
    skillsetName: skillsetConfig.name,
  }

  if (result.queueItem?.id && result.status !== 'merged') {
    metadata.pendingQueueItemId = result.queueItem.id
  } else if (result.status === 'merged') {
    await refreshSkillset(skillsetRef)
    const repoDirAfter = getSkillsetRepoDirForRef(skillsetRef)
    const agentDirInRepo = path.join(repoDirAfter, agentPathInRepo.replace(/\/$/, ''))
    if (await directoryExists(agentDirInRepo)) {
      await copyTemplateFiles(agentDirInRepo, workspaceDir)
    } else {
      await fs.promises.writeFile(claudeMdPath, claudeMdContent, 'utf-8')
    }
    metadata.originalContentHash = await computeAgentTemplateHash(workspaceDir)
  }

  if (result.prUrl) {
    metadata.openPrUrl = result.prUrl
  }

  await writeJsonFile(getAgentMetadataPath(agentSlug), metadata)
  return { prUrl: result.prUrl, successMessage: result.successMessage }
}
