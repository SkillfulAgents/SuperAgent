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
  fileExists,
  writeFileAtomic,
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
  generateAgentId,
  displaySlug,
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
import { messagePersister } from '@shared/lib/container/message-persister'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { getSessionSummary } from './session-service'

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
  const healthWarnings = containerManager.getHealthWarnings(agent.slug)
  return {
    slug: agent.slug,
    displaySlug: displaySlug(agent.frontmatter.name, agent.slug),
    name: agent.frontmatter.name,
    description: agent.frontmatter.description,
    instructions: agent.instructions,
    createdAt: new Date(agent.frontmatter.createdAt),
    status,
    containerPort,
    ...(healthWarnings.length > 0 ? { healthWarnings } : {}),
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
    frontmatter.name = slug
  }
  frontmatter.name = String(frontmatter.name)

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
 * List agent slugs only — a directory listing plus a CLAUDE.md existence
 * check per entry, no frontmatter parsing. For callers that need scope
 * (which agents exist), not identity; listAgents() reads every agent's
 * CLAUDE.md sequentially, which is too heavy to run per request.
 */
export async function listAgentSlugs(): Promise<string[]> {
  const agentsDir = getAgentsDir()
  await ensureDirectory(agentsDir)
  const slugs = await listDirectories(agentsDir)
  const checks = await Promise.all(
    slugs.map(async (slug) => ((await fileExists(getAgentClaudeMdPath(slug))) ? slug : null)),
  )
  return checks.filter((slug): slug is string => slug !== null)
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
  const base = toApiAgent(agent, info.status, info.port)

  // Compute session activity flags (same logic as the list endpoint)
  const sessionSummary = await getSessionSummary(slug)
  let hasActiveSessions = false
  let hasSessionsAwaitingInput = false
  for (const sessionId of sessionSummary.sessionIds) {
    if (messagePersister.isSessionActive(sessionId)) hasActiveSessions = true
    if (messagePersister.isSessionAwaitingInput(sessionId)) hasSessionsAwaitingInput = true
  }
  if (!hasActiveSessions) {
    hasActiveSessions = messagePersister.hasActiveSessionsForAgent(slug)
  }
  if (!hasSessionsAwaitingInput) {
    hasSessionsAwaitingInput = messagePersister.hasSessionsAwaitingInputForAgent(slug)
  }
  if (reviewManager.getPendingReviewsForAgent(slug).length > 0) {
    hasSessionsAwaitingInput = true
  }

  return {
    ...base,
    hasActiveSessions,
    hasSessionsAwaitingInput,
    sessionCount: sessionSummary.sessionCount,
    lastActivityAt: sessionSummary.lastActivityAt,
  }
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
  const { name: rawName, description, instructions } = input
  const name = String(rawName)

  // Mint an opaque id — the name no longer feeds the folder, so the "Untitled"
  // promptless-create flow can't poison it.
  const slug = await generateAgentId()

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
  await writeFileAtomic(claudeMdPath, content)

  // Return in API format (new agents are always stopped)
  return {
    slug,
    displaySlug: displaySlug(name, slug),
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
    newFrontmatter.name = String(updates.name)
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
  await writeFileAtomic(claudeMdPath, content)

  // Get container status
  const client = containerManager.getClient(slug)
  const info = await client.getInfo()

  return {
    slug,
    displaySlug: displaySlug(newFrontmatter.name, slug),
    name: newFrontmatter.name,
    description: newFrontmatter.description,
    instructions: newInstructions,
    createdAt: new Date(newFrontmatter.createdAt),
    status: info.status,
    containerPort: info.port,
  }
}

/**
 * Thrown by {@link deleteAgent} when the agent's container cannot be stopped.
 *
 * stopContainer is idempotent for already-stopped/missing containers, so a
 * rejection signals a GENUINE runtime failure (wedged VM, unexpected stop
 * error). Deletion aborts before the irreversible workspace removal, so the
 * agent is preserved and the operation is retryable. The DELETE route catches
 * this to surface an actionable message instead of a generic 500.
 */
export class AgentContainerStopError extends Error {
  readonly slug: string
  constructor(slug: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to stop the container for agent "${slug}": ${detail}`)
    this.name = 'AgentContainerStopError'
    this.slug = slug
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

  // Stop the container before removing the workspace.
  //
  // stopContainer is idempotent for already-stopped/missing containers: the
  // underlying client silently ignores benign "no such container" cases and
  // resolves without throwing. Therefore any rejection here signals a GENUINE
  // runtime failure (e.g. a wedged VM or an unexpected stop error), in which
  // case the container may still be running or be in an unknown stop state.
  //
  // We must NOT delete the host workspace in that situation. Re-throw as a
  // typed error so the API/UI can surface an actionable failure; removeDirectory
  // below never runs, so the workspace is preserved and the delete is retryable.
  try {
    await containerManager.stopContainer(slug)
  } catch (error) {
    throw new AgentContainerStopError(slug, error)
  }

  // Remove directory only after the container has been confirmed stopped.
  await removeDirectory(agentDir)

  return true
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a new agent with an empty workspace, ready for files to be placed into it.
 * Used by template import/install which populates the workspace after creation.
 */
export async function createAgentFromExistingWorkspace(rawName: string): Promise<ApiAgent> {
  const name = String(rawName)
  const slug = await generateAgentId()

  const workspaceDir = getAgentWorkspaceDir(slug)
  await ensureDirectory(workspaceDir)

  // Create a basic CLAUDE.md (may be overwritten by template)
  const claudeMdPath = getAgentClaudeMdPath(slug)
  const frontmatter: AgentFrontmatter = {
    name,
    createdAt: new Date().toISOString(),
  }

  const body = DEFAULT_AGENT_INSTRUCTIONS
  const content = serializeMarkdownWithFrontmatter(frontmatter, body)
  await writeFileAtomic(claudeMdPath, content)

  return {
    slug,
    displaySlug: displaySlug(name, slug),
    name,
    createdAt: new Date(frontmatter.createdAt),
    status: 'stopped',
    containerPort: null,
  }
}

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
  await writeFileAtomic(claudeMdPath, content)
}
