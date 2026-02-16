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
import { execFile } from 'child_process'
import { promisify } from 'util'
import Anthropic from '@anthropic-ai/sdk'
import {
  getAgentWorkspaceDir,
  getAgentClaudeMdPath,
  readFileOrNull,
  ensureDirectory,
  directoryExists,
  parseMarkdownWithFrontmatter,
} from '@shared/lib/utils/file-storage'
import { getEffectiveAnthropicApiKey, getEffectiveModels } from '@shared/lib/config/settings'
import { withRetry } from '@shared/lib/utils/retry'
import {
  ensureSkillsetCached,
  getSkillsetRepoDir,
  getSkillsetIndex,
  readIndexJson,
  refreshSkillset,
  prepareForkBranch,
  pushAndCreatePR,
  copyDirectory,
} from '@shared/lib/services/skillset-service'
import { createAgentFromExistingWorkspace } from '@shared/lib/services/agent-service'
import type {
  SkillsetConfig,
  InstalledAgentMetadata,
  AgentTemplateStatus,
  DiscoverableAgent,
} from '@shared/lib/types/skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentFrontmatter } from '@shared/lib/types/agent'

const execFileAsync = promisify(execFile)

// ============================================================================
// Constants
// ============================================================================

const MAX_UNCOMPRESSED_SIZE = 100 * 1024 * 1024 // 100MB
const MAX_FILE_COUNT = 1000

/** Files/dirs excluded from templates (matched by name at any level) */
const TEMPLATE_EXCLUDE = new Set([
  '.env',
  '.DS_Store',
  'session-metadata.json',
  '.superagent-sessions.json',
  '.skillset-agent-metadata.json',
])

/** Top-level directories excluded from templates entirely */
const TEMPLATE_EXCLUDE_TOP_DIRS = new Set([
  'uploads',
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

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
}

// ============================================================================
// Metadata Path Helpers
// ============================================================================

function getAgentMetadataPath(agentSlug: string): string {
  return path.join(getAgentWorkspaceDir(agentSlug), '.skillset-agent-metadata.json')
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
        files.push(relativePath)
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
 */
export function validateAgentTemplate(zipBuffer: Buffer): TemplateValidationResult {
  try {
    const zip = new AdmZip(zipBuffer)
    const entries = zip.getEntries()

    // Filter out macOS resource fork entries for all checks
    const realEntries = entries.filter((e) => !e.entryName.startsWith('__MACOSX/'))

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
): Promise<ApiAgent> {
  const validation = validateAgentTemplate(zipBuffer)
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

    // Security: skip secrets and excluded files even if present
    const baseName = path.basename(entryName)
    if (baseName === '.env' || baseName === 'session-metadata.json') continue

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
  const { getAgentWithStatus } = await import('@shared/lib/services/agent-service')
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
  skillsetId: string,
  skillsetUrl: string,
  agentPath: string,
  agentName: string,
  agentVersion: string,
): Promise<ApiAgent> {
  const repoDir = getSkillsetRepoDir(skillsetId)
  if (!(await directoryExists(path.join(repoDir, '.git')))) {
    await ensureSkillsetCached(skillsetId, skillsetUrl)
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
  await copyDirectory(agentDirInRepo, workspaceDir)

  // Compute hash of template files
  const hash = await computeAgentTemplateHash(workspaceDir)

  // Write agent metadata
  const metadata: InstalledAgentMetadata = {
    skillsetId,
    skillsetUrl,
    agentName,
    agentPath,
    installedVersion: agentVersion,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
  }

  await fs.promises.writeFile(
    getAgentMetadataPath(agent.slug),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  )

  // Re-read the agent
  const { getAgentWithStatus } = await import('@shared/lib/services/agent-service')
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

  // Refresh the skillset cache
  await refreshSkillset(meta.skillsetId, meta.skillsetUrl)

  // Re-read the index to get the latest version
  const index = await getSkillsetIndex(meta.skillsetId)
  if (!index || !index.agents) return { updated: false }

  const agentEntry = index.agents.find((a) => a.path === meta.agentPath)
  if (!agentEntry) return { updated: false }

  const repoDir = getSkillsetRepoDir(meta.skillsetId)
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

/**
 * Copy template files from source to dest, preserving excluded files in dest.
 */
async function copyTemplateFiles(src: string, dest: string): Promise<void> {
  await ensureDirectory(dest)
  const entries = await fs.promises.readdir(src, { withFileTypes: true })

  const EXCLUDED = new Set(['.git', '.skillset-metadata.json', '.skillset-original.md', '.skillset-agent-metadata.json'])

  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue

    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyTemplateFiles(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
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
 * Get the template status of an agent.
 */
export async function getAgentTemplateStatus(
  agentSlug: string,
  skillsets: SkillsetConfig[],
): Promise<AgentTemplateStatus> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    return { type: 'local' }
  }

  const skillsetName = skillsets.find((s) => s.id === meta.skillsetId)?.name || meta.skillsetId

  // Check for local modifications
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const currentHash = await computeAgentTemplateHash(workspaceDir)

  if (currentHash !== meta.originalContentHash) {
    return { type: 'locally_modified', skillsetId: meta.skillsetId, skillsetName, openPrUrl: meta.openPrUrl }
  }

  if (meta.openPrUrl) {
    return { type: 'locally_modified', skillsetId: meta.skillsetId, skillsetName, openPrUrl: meta.openPrUrl }
  }

  // Check for updates
  const index = await getSkillsetIndex(meta.skillsetId)
  const agentEntry = index?.agents?.find((a) => a.path === meta.agentPath)

  if (agentEntry && agentEntry.version !== meta.installedVersion) {
    return {
      type: 'update_available',
      skillsetId: meta.skillsetId,
      skillsetName,
      latestVersion: agentEntry.version,
    }
  }

  return { type: 'up_to_date', skillsetId: meta.skillsetId, skillsetName }
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
    const index = await getSkillsetIndex(ss.id)
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
      try {
        await ensureSkillsetCached(ss.id, ss.url)
        await refreshSkillset(ss.id, ss.url)
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
      await refreshSkillset(ss.id, ss.url)
    } catch (error) {
      console.warn(`Failed to refresh skillset ${ss.id}:`, error)
    }
  }

  // Reconcile installed agents
  const { listAgents } = await import('@shared/lib/services/agent-service')
  const agents = await listAgents()

  for (const agent of agents) {
    const meta = await getInstalledAgentMetadata(agent.slug)
    if (!meta) continue

    const workspaceDir = getAgentWorkspaceDir(agent.slug)
    const currentHash = await computeAgentTemplateHash(workspaceDir)

    // If content matches original and has openPrUrl, check if PR was merged
    if (currentHash === meta.originalContentHash && meta.openPrUrl) {
      const repoDir = getSkillsetRepoDir(meta.skillsetId)
      const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
      if (await directoryExists(agentDirInRepo)) {
        const repoHash = await computeAgentTemplateHash(agentDirInRepo)
        if (repoHash === currentHash) {
          meta.openPrUrl = undefined
          await fs.promises.writeFile(
            getAgentMetadataPath(agent.slug),
            JSON.stringify(meta, null, 2),
            'utf-8'
          )
        }
      }
    }

    // If modified, check if changes are now upstream
    if (currentHash !== meta.originalContentHash) {
      const repoDir = getSkillsetRepoDir(meta.skillsetId)
      const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
      if (await directoryExists(agentDirInRepo)) {
        const repoHash = await computeAgentTemplateHash(agentDirInRepo)
        if (repoHash === currentHash) {
          meta.originalContentHash = currentHash
          meta.openPrUrl = undefined
          await fs.promises.writeFile(
            getAgentMetadataPath(agent.slug),
            JSON.stringify(meta, null, 2),
            'utf-8'
          )
        }
      }
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

  const apiKey = getEffectiveAnthropicApiKey()
  if (!apiKey) return fallback

  try {
    const client = new Anthropic({ apiKey })
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

    const textBlock = response.content.find((block) => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') return fallback

    const parsed = JSON.parse(textBlock.text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch (error) {
    console.error('Failed to generate agent PR suggestions:', error)
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

  const apiKey = getEffectiveAnthropicApiKey()
  if (!apiKey) return fallback

  try {
    const client = new Anthropic({ apiKey })
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

    const textBlock = response.content.find((block) => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') return fallback

    const parsed = JSON.parse(textBlock.text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch (error) {
    console.error('Failed to generate agent publish suggestions:', error)
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

  // Check gh CLI
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 })
  } catch {
    throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com')
  }

  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 })
  } catch {
    throw new Error('GitHub CLI is not authenticated. Run `gh auth login` to sign in.')
  }

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
): Promise<{ prUrl: string }> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    throw new Error('Agent has no skillset metadata - cannot create PR')
  }

  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const repoDir = getSkillsetRepoDir(meta.skillsetId)
  const ctx = await prepareForkBranch(repoDir, `update-agent-${agentSlug}`)

  // Copy template files from workspace to the repo agent dir
  const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
  await ensureDirectory(agentDirInRepo)

  const templateFiles = await walkTemplateFiles(workspaceDir)
  for (const relativePath of templateFiles) {
    const srcPath = path.join(workspaceDir, relativePath)
    const destPath = path.join(agentDirInRepo, relativePath)
    await ensureDirectory(path.dirname(destPath))
    await fs.promises.copyFile(srcPath, destPath)
  }

  // Update version in index.json if provided
  if (options.newVersion) {
    const index = await readIndexJson(repoDir)
    if (index.agents) {
      const agentEntry = index.agents.find((a) => a.path === meta.agentPath)
      if (agentEntry) {
        agentEntry.version = options.newVersion
        await fs.promises.writeFile(
          path.join(repoDir, 'index.json'),
          JSON.stringify(index, null, 2) + '\n',
          'utf-8'
        )
      }
    }
  }

  // Stage and commit
  await execFileAsync('git', ['add', '.'], {
    cwd: repoDir, timeout: 10000, env: GIT_ENV,
  })

  await execFileAsync(
    'git',
    ['commit', '-m', options.title],
    { cwd: repoDir, timeout: 10000, env: GIT_ENV }
  )

  const prUrl = await pushAndCreatePR(ctx, options)

  // Save PR URL in metadata
  meta.openPrUrl = prUrl
  await fs.promises.writeFile(
    getAgentMetadataPath(agentSlug),
    JSON.stringify(meta, null, 2),
    'utf-8'
  )

  return { prUrl }
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

  // Check gh CLI
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 })
  } catch {
    throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com')
  }

  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 })
  } catch {
    throw new Error('GitHub CLI is not authenticated. Run `gh auth login` to sign in.')
  }

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
): Promise<{ prUrl: string }> {
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  const claudeMdContent = await readFileOrNull(getAgentClaudeMdPath(agentSlug))
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }

  const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
  const agentName = frontmatter.name || agentSlug
  const description = frontmatter.description || ''
  const version = options.newVersion || '1.0.0'

  // Slugify the agent name for the path
  const agentDirName = agentSlug
  const agentPathInRepo = `agents/${agentDirName}/`

  // Ensure the skillset cache is available
  const repoDir = getSkillsetRepoDir(skillsetConfig.id)
  if (!(await directoryExists(path.join(repoDir, '.git')))) {
    await ensureSkillsetCached(skillsetConfig.id, skillsetConfig.url)
  }

  const ctx = await prepareForkBranch(repoDir, `add-agent-${agentDirName}`)

  // Check for naming conflict
  const index = await readIndexJson(repoDir)
  const agents = index.agents || []
  const conflict = agents.find((a) => a.path === agentPathInRepo)
  if (conflict) {
    // Clean up
    await execFileAsync('git', ['checkout', ctx.baseBranch], {
      cwd: repoDir, timeout: 10000, env: GIT_ENV,
    }).catch(() => {})
    await execFileAsync('git', ['branch', '-D', ctx.branchName], {
      cwd: repoDir, timeout: 5000, env: GIT_ENV,
    }).catch(() => {})
    throw new Error(
      `An agent already exists at "${agentPathInRepo}" in this skillset.`
    )
  }

  // Create agent directory and copy template files
  const destDir = path.join(repoDir, 'agents', agentDirName)
  await ensureDirectory(destDir)

  const templateFiles = await walkTemplateFiles(workspaceDir)
  for (const relativePath of templateFiles) {
    const srcPath = path.join(workspaceDir, relativePath)
    const destPath = path.join(destDir, relativePath)
    await ensureDirectory(path.dirname(destPath))
    await fs.promises.copyFile(srcPath, destPath)
  }

  // Update index.json with the new agent entry
  if (!index.agents) {
    index.agents = []
  }
  index.agents.push({
    name: agentName,
    path: agentPathInRepo,
    description,
    version,
  })
  await fs.promises.writeFile(
    path.join(repoDir, 'index.json'),
    JSON.stringify(index, null, 2) + '\n',
    'utf-8'
  )

  // Stage and commit
  await execFileAsync('git', ['add', '.'], {
    cwd: repoDir, timeout: 10000, env: GIT_ENV,
  })

  await execFileAsync(
    'git',
    ['commit', '-m', options.title],
    { cwd: repoDir, timeout: 10000, env: GIT_ENV }
  )

  const prUrl = await pushAndCreatePR(ctx, options)

  // Write metadata so the agent is now tracked
  const hash = await computeAgentTemplateHash(workspaceDir)
  const metadata: InstalledAgentMetadata = {
    skillsetId: skillsetConfig.id,
    skillsetUrl: skillsetConfig.url,
    agentName,
    agentPath: agentPathInRepo,
    installedVersion: version,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    openPrUrl: prUrl,
  }

  await fs.promises.writeFile(
    getAgentMetadataPath(agentSlug),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  )

  return { prUrl }
}
