/**
 * Agent Service
 *
 * CRUD operations for agents. Which agents exist and what they are called is
 * the catalog's (the `agents` table); an agent's instructions are the body of
 * the `CLAUDE.md` in its workspace, read and written through the agent
 * actor's `config` document `instructions`. The frontmatter of that document
 * is a projection of the catalog row that the host writes on create and
 * rename, so the agent still sees who it is and exports still carry it.
 */

import {
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
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
import {
  agentCatalog,
  agentRegistry,
  identityFromInstructions,
  type AgentIdentityChanges,
  type AgentRecord,
} from '@shared/lib/agent-actor'

// ============================================================================
// Internal to API Type Conversion
// ============================================================================

/**
 * Convert a catalog record to API format. Instructions are only carried by
 * the single-agent responses; the list never reads a workspace.
 */
function toApiAgent(
  record: AgentRecord,
  status: 'running' | 'stopped',
  containerPort: number | null,
  instructions?: string,
): ApiAgent {
  const healthWarnings = agentRegistry.get(record.slug).container.health()
  return {
    slug: record.slug,
    displaySlug: displaySlug(record.name, record.slug),
    name: record.name,
    description: record.description,
    ...(instructions === undefined ? {} : { instructions }),
    createdAt: record.createdAt,
    status,
    containerPort,
    ...(healthWarnings.length > 0 ? { healthWarnings } : {}),
  }
}

/**
 * The frontmatter the host projects into `CLAUDE.md`: the row's identity over
 * whatever other keys the document carries (a template version, say).
 */
function projectedFrontmatter(record: AgentRecord, carried: Record<string, unknown>): AgentFrontmatter {
  const frontmatter = {
    ...carried,
    name: record.name,
    createdAt: record.createdAt.toISOString(),
  } as AgentFrontmatter
  if (record.description === undefined) delete frontmatter.description
  else frontmatter.description = record.description
  return frontmatter
}

async function readInstructionsDocument(slug: string): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
  const content = await agentRegistry.get(slug).config.get('instructions')
  if (content === null) return null
  return parseMarkdownWithFrontmatter<Record<string, unknown>>(content)
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * An agent's identity and placement, from the catalog alone. For callers that
 * need a name, a description or a creation date and never the instructions.
 */
export async function getAgentRecord(slug: string): Promise<AgentRecord | null> {
  return agentCatalog.get(slug)
}

/** Every agent slug on this host, newest first. */
export async function listAgentSlugs(): Promise<string[]> {
  return agentCatalog.list()
}

/**
 * Get a single agent by slug: its identity from the catalog, its instructions
 * from the workspace. Null when there is no such agent; a workspace whose
 * `CLAUDE.md` cannot be read is an error, not a missing agent.
 */
export async function getAgent(slug: string): Promise<AgentConfig | null> {
  const record = await agentCatalog.get(slug)
  if (!record) return null
  const document = await readInstructionsDocument(slug)
  return {
    slug,
    frontmatter: projectedFrontmatter(record, document?.frontmatter ?? {}),
    instructions: document?.body ?? '',
  }
}

/**
 * Get a single agent with container status (returns API format)
 * Uses cached container status to avoid spawning docker processes.
 */
export async function getAgentWithStatus(
  slug: string,
  options: { includeSummary?: boolean } = {},
): Promise<ApiAgent | null> {
  const agent = await getAgent(slug)
  if (!agent) {
    return null
  }

  const actor = agentRegistry.get(slug)
  // Use cached status to avoid spawning docker processes
  const info = actor.container.status()
  const record = (await agentCatalog.get(slug))!
  const base = toApiAgent(record, info.status, info.port, agent.instructions)

  // Routes that either discard the body (/start) or immediately run the richer
  // enrichAgentsWithSummary pass (list/detail) skip this otherwise-duplicate
  // O(session-count) stat scan; standalone callers keep the enriched default.
  if (options.includeSummary === false) return base

  // Compute session activity flags (same logic as the list endpoint)
  const sessionSummary = await actor.sessions.summary()
  let hasActiveSessions = false
  let hasSessionsAwaitingInput = false
  for (const sessionId of sessionSummary.sessionIds) {
    if (actor.sessions.isActive(sessionId)) hasActiveSessions = true
    if (actor.sessions.isAwaitingInput(sessionId)) hasSessionsAwaitingInput = true
  }
  if (!hasActiveSessions) {
    hasActiveSessions = actor.sessions.hasActive()
  }
  if (!hasSessionsAwaitingInput) {
    hasSessionsAwaitingInput = actor.sessions.hasAwaitingInput()
  }
  if (actor.inputs.reviews.pending().length > 0) {
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

/** Every agent, newest first. One query; no workspace is read. */
export async function listAgents(): Promise<AgentRecord[]> {
  return agentCatalog.records()
}

/**
 * List agents with container status (returns API format), newest first.
 * `slugs` restricts the listing to those agents, for the ACL-scoped list.
 * Uses cached container status to avoid spawning docker processes.
 */
export async function listAgentsWithStatus(options: { slugs?: string[] } = {}): Promise<ApiAgent[]> {
  const records = options.slugs ? await agentCatalog.getMany(options.slugs) : await agentCatalog.records()

  // Use cached status to avoid spawning docker processes
  return records.map((record) => {
    const info = agentRegistry.get(record.slug).container.status()
    return toApiAgent(record, info.status, info.port)
  })
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
  const body = instructions || DEFAULT_AGENT_INSTRUCTIONS
  const record = await writeNewAgent({ name, description: description || undefined }, body)
  return toApiAgent(record, 'stopped', null, body)
}

/**
 * Mint a slug, write the workspace, then record the agent. The row is written
 * last so a workspace that failed to write never shows as an agent; a
 * workspace whose row failed to write is imported at the next boot.
 */
async function writeNewAgent(
  identity: { name: string; description?: string },
  body: string,
): Promise<AgentRecord> {
  // Mint an opaque id — the name no longer feeds the folder, so the "Untitled"
  // promptless-create flow can't poison it.
  const slug = await agentCatalog.mint()
  const actor = agentRegistry.get(slug)
  const createdAt = new Date()

  await actor.files.mkdir('')

  const frontmatter: AgentFrontmatter = { name: identity.name, createdAt: createdAt.toISOString() }
  if (identity.description) {
    frontmatter.description = identity.description
  }
  await actor.config.put('instructions', serializeMarkdownWithFrontmatter(frontmatter, body))

  return agentCatalog.insert({ slug, name: identity.name, description: identity.description, createdAt })
}

/**
 * Update agent metadata and/or instructions (returns API format)
 */
export async function updateAgent(
  slug: string,
  updates: UpdateAgentInput
): Promise<ApiAgent | null> {
  const record = await agentCatalog.get(slug)
  if (!record) {
    return null
  }

  const changes: AgentIdentityChanges = {}
  if (updates.name !== undefined) {
    changes.name = String(updates.name)
  }
  if (updates.description !== undefined) {
    changes.description = updates.description || null
  }
  const updated = (await agentCatalog.update(slug, changes)) ?? record

  // Rewrite the document: the new body if given, and the identity projection
  // either way, so the agent sees its new name.
  const actor = agentRegistry.get(slug)
  const document = await readInstructionsDocument(slug)
  const body = updates.instructions !== undefined ? updates.instructions : document?.body ?? ''
  await actor.config.put(
    'instructions',
    serializeMarkdownWithFrontmatter(projectedFrontmatter(updated, document?.frontmatter ?? {}), body),
  )

  // Get container status
  const info = await actor.container.info()

  return toApiAgent(updated, info.status, info.port, body)
}

/**
 * Rewrite the identity projection in an agent's `CLAUDE.md` from its catalog
 * row, keeping the document's other frontmatter keys and its body. For after
 * something else has replaced the document, such as a template update.
 */
export async function writeAgentIdentityProjection(slug: string): Promise<void> {
  const record = await agentCatalog.get(slug)
  if (!record) return
  const document = await readInstructionsDocument(slug)
  if (!document) return
  await writeProjection(record, document)
}

async function writeProjection(
  record: AgentRecord,
  document: { frontmatter: Record<string, unknown>; body: string },
): Promise<void> {
  await agentRegistry.get(record.slug).config.put(
    'instructions',
    serializeMarkdownWithFrontmatter(projectedFrontmatter(record, document.frontmatter), document.body),
  )
}

/**
 * Take an agent's name and description from the `CLAUDE.md` its workspace
 * now holds (an imported template, an installed skillset agent), then write
 * the projection back. `name` overrides whatever the document carries; a
 * document without a name keeps the row's. The creation date stays the row's.
 */
export async function adoptAgentIdentityFromWorkspace(
  slug: string,
  overrides: { name?: string } = {},
): Promise<AgentRecord | null> {
  const record = await agentCatalog.get(slug)
  if (!record) return null
  const content = await agentRegistry.get(slug).config.get('instructions')
  const carried = content === null ? {} : identityFromInstructions(content)
  const name = overrides.name?.trim() || carried.name || record.name
  const description = carried.description ?? record.description ?? null
  const updated = (await agentCatalog.update(slug, { name, description })) ?? record
  // One read of the document serves both the adoption and the projection.
  if (content !== null) {
    await writeProjection(updated, parseMarkdownWithFrontmatter<Record<string, unknown>>(content))
  }
  return updated
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
  if (!(await agentCatalog.exists(slug))) {
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
  // typed error so the API/UI can surface an actionable failure; the catalog
  // removal below never runs, so the workspace is preserved and the delete is
  // retryable.
  try {
    await agentRegistry.get(slug).container.stop()
  } catch (error) {
    throw new AgentContainerStopError(slug, error)
  }

  // Remove the agent only after the container has been confirmed stopped, then
  // forget the handle and runtime the stop above created for it.
  await agentCatalog.remove(slug)
  agentRegistry.evict(slug)

  return true
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a new agent with an empty workspace, ready for files to be placed into it.
 * Used by template import/install which populates the workspace after creation
 * and then adopts the identity the template carries.
 */
export async function createAgentFromExistingWorkspace(rawName: string): Promise<ApiAgent> {
  const name = String(rawName)
  // A basic CLAUDE.md (may be overwritten by template)
  const record = await writeNewAgent({ name }, DEFAULT_AGENT_INSTRUCTIONS)
  return toApiAgent(record, 'stopped', null)
}

/**
 * Check if an agent exists
 */
export async function agentExists(slug: string): Promise<boolean> {
  return agentCatalog.exists(slug)
}

/**
 * Get raw CLAUDE.md content (for editor)
 */
export async function getAgentClaudeMdContent(slug: string): Promise<string | null> {
  return agentRegistry.get(slug).config.get('instructions')
}

/**
 * Set raw CLAUDE.md content (from editor)
 */
export async function setAgentClaudeMdContent(
  slug: string,
  content: string
): Promise<void> {
  await agentRegistry.get(slug).config.put('instructions', content)
}
