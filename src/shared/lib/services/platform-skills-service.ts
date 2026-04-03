/**
 * Platform Skills Service
 *
 * Fetches skills and agents from the Platform proxy API (/v1/skills/...).
 * This is completely independent of the git-based skillset system.
 */

import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { getPlatformAccessToken } from './platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getAgentWorkspaceDir, ensureDirectory } from '@shared/lib/utils/file-storage'

// ---------------------------------------------------------------------------
// Types (mirroring platform/packages/skills/src/types.ts)
// ---------------------------------------------------------------------------

export interface PlatformSkillRegistryEntry {
  name: string
  path: string
  description: string
  skill_count: number
  agent_count: number
}

export interface PlatformSkillsetIndexSkill {
  name: string
  path: string
  description: string
}

export interface PlatformSkillsetIndexAgent {
  name: string
  path: string
  description: string
}

export interface PlatformSkillsetIndex {
  skillset_name: string
  description: string
  skills: PlatformSkillsetIndexSkill[]
  agents?: PlatformSkillsetIndexAgent[]
}

export interface PlatformSkillContent {
  path: string
  content: string
}

export interface PlatformSkillFile {
  path: string
  content: string
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

class PlatformSkillsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'PlatformSkillsError'
  }
}

function getAuthHeaders(): Record<string, string> {
  const token = getPlatformAccessToken()
  if (!token) throw new PlatformSkillsError('Platform not connected', 401)
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
}

function getBaseUrl(): string {
  const base = getPlatformProxyBaseUrl()
  if (!base) throw new PlatformSkillsError('Platform proxy URL not configured', 500)
  return base
}

async function platformFetch<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}/v1/skills${path}`
  const res = await fetch(url, { headers: getAuthHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PlatformSkillsError(
      `Platform skills API error (${res.status}): ${body}`,
      res.status,
    )
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all skillsets in the connected org.
 */
export async function listPlatformSkillsets(): Promise<PlatformSkillRegistryEntry[]> {
  const data = await platformFetch<{ skillsets: PlatformSkillRegistryEntry[] }>('/skillsets')
  return data.skillsets
}

/**
 * Get a single skillset by name (includes skills and agents arrays).
 */
export async function getPlatformSkillset(name: string): Promise<PlatformSkillsetIndex> {
  const data = await platformFetch<{ skillset: PlatformSkillsetIndex }>(
    `/skillsets/${encodeURIComponent(name)}`,
  )
  return data.skillset
}

/**
 * Get the content of a specific skill.
 */
export async function getPlatformSkillContent(
  skillsetName: string,
  skillName: string,
): Promise<PlatformSkillContent> {
  return platformFetch<PlatformSkillContent>(
    `/skillsets/${encodeURIComponent(skillsetName)}/skills/${encodeURIComponent(skillName)}`,
  )
}

/**
 * List files for a specific skill.
 */
export async function listPlatformSkillFiles(
  skillsetName: string,
  skillName: string,
): Promise<PlatformSkillFile[]> {
  const data = await platformFetch<{ files: PlatformSkillFile[] }>(
    `/skillsets/${encodeURIComponent(skillsetName)}/skills/${encodeURIComponent(skillName)}/files`,
  )
  return data.files
}

export interface PlatformAgentTemplate {
  rootPath: string
  files: PlatformSkillFile[]
}

/**
 * Get an agent template from the platform.
 */
export async function getPlatformAgentTemplate(
  skillsetName: string,
  agentName: string,
): Promise<PlatformAgentTemplate> {
  const data = await platformFetch<{ template: PlatformAgentTemplate }>(
    `/skillsets/${encodeURIComponent(skillsetName)}/agents/${encodeURIComponent(agentName)}`,
  )
  return data.template
}

/**
 * Download the full skill bundle (all files with content).
 */
export async function getPlatformSkillBundle(
  skillsetName: string,
  skillName: string,
): Promise<PlatformSkillFile[]> {
  const data = await platformFetch<{ files: PlatformSkillFile[] }>(
    `/skillsets/${encodeURIComponent(skillsetName)}/skills/${encodeURIComponent(skillName)}/bundle`,
  )
  return data.files
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function getAgentSkillsDir(agentSlug: string): string {
  return path.join(getAgentWorkspaceDir(agentSlug), '.claude', 'skills')
}

/**
 * Install a skill from the platform org into a local agent.
 * Downloads all files via the proxy bundle endpoint and writes them
 * to the agent's skills directory, matching the git-based install layout.
 */
export async function installSkillFromPlatform(
  agentSlug: string,
  skillsetName: string,
  skillName: string,
  displayName: string,
): Promise<{ installed: boolean; fileCount: number }> {
  const files = await getPlatformSkillBundle(skillsetName, skillName)
  if (files.length === 0) {
    throw new PlatformSkillsError('No files found for this skill', 404)
  }

  const destDir = path.join(getAgentSkillsDir(agentSlug), skillName)
  await ensureDirectory(destDir)

  for (const file of files) {
    const filePath = path.join(destDir, file.path)
    await ensureDirectory(path.dirname(filePath))
    await fs.promises.writeFile(filePath, file.content, 'utf-8')
  }

  // Write metadata so the system knows where this skill came from
  const skillMdContent = files.find((f) => f.path === 'SKILL.md')?.content
  const metadata = {
    skillsetId: `platform:${skillsetName}`,
    skillsetUrl: `platform://${skillsetName}`,
    skillName: displayName,
    skillPath: `skills/${skillName}/SKILL.md`,
    installedVersion: '0.0.0',
    installedAt: new Date().toISOString(),
    originalContentHash: skillMdContent
      ? crypto.createHash('sha256').update(skillMdContent, 'utf-8').digest('hex')
      : '',
    source: 'platform',
  }

  await fs.promises.writeFile(
    path.join(destDir, '.skillset-metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8',
  )

  if (skillMdContent) {
    await fs.promises.writeFile(
      path.join(destDir, '.skillset-original.md'),
      skillMdContent,
      'utf-8',
    )
  }

  return { installed: true, fileCount: files.length }
}

/**
 * Install an agent template from the platform org as a new local agent.
 * Downloads all files via the proxy agent template endpoint and writes them
 * into a fresh agent workspace, mirroring the git-based installAgentFromSkillset flow.
 */
export async function installAgentFromPlatform(
  skillsetName: string,
  agentName: string,
  displayName: string,
): Promise<{ agentSlug: string; fileCount: number }> {
  const { createAgentFromExistingWorkspace } = await import('./agent-service')

  const template = await getPlatformAgentTemplate(skillsetName, agentName)
  if (!template.files || template.files.length === 0) {
    throw new PlatformSkillsError('No files found for this agent template', 404)
  }

  const agent = await createAgentFromExistingWorkspace(displayName)
  const workspaceDir = getAgentWorkspaceDir(agent.slug)

  // Strip the rootPath prefix from file paths so they're relative to workspace
  const rootPrefix = template.rootPath ? `${template.rootPath}/` : ''

  for (const file of template.files) {
    const relativePath = file.path.startsWith(rootPrefix)
      ? file.path.slice(rootPrefix.length)
      : file.path
    if (!relativePath) continue

    const filePath = path.join(workspaceDir, relativePath)
    await ensureDirectory(path.dirname(filePath))
    await fs.promises.writeFile(filePath, file.content, 'utf-8')
  }

  // Compute hash of all template files for metadata tracking
  const allContent = template.files
    .map((f) => f.content)
    .join('')
  const hash = crypto.createHash('sha256').update(allContent, 'utf-8').digest('hex')

  // Write agent metadata so the system knows this came from platform
  const metadata = {
    skillsetId: `platform:${skillsetName}`,
    skillsetUrl: `platform://${skillsetName}`,
    agentName: displayName,
    agentPath: `agents/${agentName}/`,
    installedVersion: '0.0.0',
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    source: 'platform',
  }

  await fs.promises.writeFile(
    path.join(workspaceDir, '.skillset-agent-metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8',
  )

  return { agentSlug: agent.slug, fileCount: template.files.length }
}
