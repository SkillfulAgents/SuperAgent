/**
 * Agent Service
 *
 * File-based CRUD operations for agents.
 * Agents are stored as directories with CLAUDE.md files.
 */

import {
  getAgentsDir,
  getAgentDir,
  getAgentWorkspaceDir,
  getAgentClaudeMdPath,
  listDirectories,
  directoryExists,
  ensureDirectory,
  removeDirectory,
  readFileOrNull,
  writeFile,
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
  generateUniqueAgentSlug,
} from '@shared/lib/utils/file-storage'
import {
  AgentFrontmatter,
  AgentConfig,
  CreateAgentInput,
  UpdateAgentInput,
  DEFAULT_AGENT_INSTRUCTIONS,
} from '@shared/lib/types/agent'
import type { ApiAgent } from '@shared/lib/types/api'
import { containerManager } from '@shared/lib/container/container-manager'

// ============================================================================
// Internal to API Type Conversion
// ============================================================================

/**
 * Convert internal AgentConfig to API format
 */
function toApiAgent(
  agent: AgentConfig,
  status: 'running' | 'stopped',
  containerPort: number | null
): ApiAgent {
  return {
    slug: agent.slug,
    name: agent.frontmatter.name,
    description: agent.frontmatter.description,
    instructions: agent.instructions,
    createdAt: new Date(agent.frontmatter.createdAt),
    status,
    containerPort,
  }
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Parse CLAUDE.md file into AgentConfig
 */
async function parseAgentClaudeMd(slug: string): Promise<AgentConfig | null> {
  const claudeMdPath = getAgentClaudeMdPath(slug)
  const content = await readFileOrNull(claudeMdPath)

  if (content === null) {
    return null
  }

  const { frontmatter, body } = parseMarkdownWithFrontmatter<AgentFrontmatter>(content)

  // Validate required fields
  if (!frontmatter.name) {
    console.warn(`Agent ${slug} has invalid CLAUDE.md: missing name`)
    // Use slug as fallback name
    frontmatter.name = slug
  }

  if (!frontmatter.createdAt) {
    // Use directory creation time as fallback
    frontmatter.createdAt = new Date().toISOString()
  }

  return {
    slug,
    frontmatter,
    instructions: body,
  }
}

/**
 * Get a single agent by slug
 */
export async function getAgent(slug: string): Promise<AgentConfig | null> {
  const agentDir = getAgentDir(slug)

  if (!(await directoryExists(agentDir))) {
    return null
  }

  return parseAgentClaudeMd(slug)
}

/**
 * Get a single agent with container status (returns API format)
 * Uses cached container status to avoid spawning docker processes.
 */
export async function getAgentWithStatus(slug: string): Promise<ApiAgent | null> {
  const agent = await getAgent(slug)
  if (!agent) {
    return null
  }

  // Use cached status to avoid spawning docker processes
  const info = containerManager.getCachedInfo(slug)

  return toApiAgent(agent, info.status, info.port)
}

/**
 * List all agents by scanning directories
 */
export async function listAgents(): Promise<AgentConfig[]> {
  const agentsDir = getAgentsDir()

  // Ensure agents directory exists
  await ensureDirectory(agentsDir)

  const slugs = await listDirectories(agentsDir)
  const agents: AgentConfig[] = []

  for (const slug of slugs) {
    const agent = await parseAgentClaudeMd(slug)
    if (agent) {
      agents.push(agent)
    }
  }

  // Sort by creation date, newest first
  agents.sort((a, b) => {
    const dateA = new Date(a.frontmatter.createdAt).getTime()
    const dateB = new Date(b.frontmatter.createdAt).getTime()
    return dateB - dateA
  })

  return agents
}

/**
 * List all agents with container status (returns API format)
 * Uses cached container status to avoid spawning docker processes.
 */
export async function listAgentsWithStatus(): Promise<ApiAgent[]> {
  const agents = await listAgents()

  // Use cached status to avoid spawning docker processes
  const agentsWithStatus = agents.map((agent) => {
    const info = containerManager.getCachedInfo(agent.slug)
    return toApiAgent(agent, info.status, info.port)
  })

  return agentsWithStatus
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new agent (returns API format with stopped status)
 */
export async function createAgent(input: CreateAgentInput): Promise<ApiAgent> {
  const { name, description, instructions } = input

  // Generate unique slug
  const slug = await generateUniqueAgentSlug(name)

  // Create directory structure
  const workspaceDir = getAgentWorkspaceDir(slug)
  await ensureDirectory(workspaceDir)

  // Create CLAUDE.md
  const claudeMdPath = getAgentClaudeMdPath(slug)
  const frontmatter: AgentFrontmatter = {
    name,
    createdAt: new Date().toISOString(),
  }
  if (description) {
    frontmatter.description = description
  }

  const body = instructions || DEFAULT_AGENT_INSTRUCTIONS
  const content = serializeMarkdownWithFrontmatter(frontmatter, body)
  await writeFile(claudeMdPath, content)

  // Return in API format (new agents are always stopped)
  return {
    slug,
    name,
    description,
    instructions: body,
    createdAt: new Date(frontmatter.createdAt),
    status: 'stopped',
    containerPort: null,
  }
}

/**
 * Update agent metadata and/or instructions (returns API format)
 */
export async function updateAgent(
  slug: string,
  updates: UpdateAgentInput
): Promise<ApiAgent | null> {
  const agent = await getAgent(slug)
  if (!agent) {
    return null
  }

  // Update frontmatter
  const newFrontmatter: AgentFrontmatter = {
    ...agent.frontmatter,
  }

  if (updates.name !== undefined) {
    newFrontmatter.name = updates.name
  }
  if (updates.description !== undefined) {
    newFrontmatter.description = updates.description || undefined
  }

  // Update instructions
  const newInstructions =
    updates.instructions !== undefined ? updates.instructions : agent.instructions

  // Write back to file
  const claudeMdPath = getAgentClaudeMdPath(slug)
  const content = serializeMarkdownWithFrontmatter(newFrontmatter, newInstructions)
  await writeFile(claudeMdPath, content)

  // Get container status
  const client = containerManager.getClient(slug)
  const info = await client.getInfo()

  return {
    slug,
    name: newFrontmatter.name,
    description: newFrontmatter.description,
    instructions: newInstructions,
    createdAt: new Date(newFrontmatter.createdAt),
    status: info.status,
    containerPort: info.port,
  }
}

/**
 * Delete an agent and all its data
 */
export async function deleteAgent(slug: string): Promise<boolean> {
  const agentDir = getAgentDir(slug)

  if (!(await directoryExists(agentDir))) {
    return false
  }

  // Stop container if running
  try {
    await containerManager.stopContainer(slug)
  } catch {
    // Ignore errors if container isn't running
  }

  // Remove directory
  await removeDirectory(agentDir)

  return true
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an agent exists
 */
export async function agentExists(slug: string): Promise<boolean> {
  const agentDir = getAgentDir(slug)
  return directoryExists(agentDir)
}

/**
 * Get raw CLAUDE.md content (for editor)
 */
export async function getAgentClaudeMdContent(slug: string): Promise<string | null> {
  const claudeMdPath = getAgentClaudeMdPath(slug)
  return readFileOrNull(claudeMdPath)
}

/**
 * Set raw CLAUDE.md content (from editor)
 */
export async function setAgentClaudeMdContent(
  slug: string,
  content: string
): Promise<void> {
  const claudeMdPath = getAgentClaudeMdPath(slug)
  await writeFile(claudeMdPath, content)
}
