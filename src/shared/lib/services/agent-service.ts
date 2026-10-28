/**
 * Agent Service
 *
 * CRUD operations for agents. Which agents exist and what they are called is
 * the catalog's (the `agents` table); an agent's instructions are the body of
 * the `AGENTS.md` in its workspace, read and written through the agent
 * actor's `config` document `instructions`. The frontmatter of that document
 * is a projection of the catalog row that the host writes on create and
 * rename, so the agent still sees who it is and exports still carry it. The
 * agent may edit the name and description there; its container reports the
 * edit and the host reads them back.
 */

import { NO_AGENT_SUMMARY, readAgentSummaries, storedAgentSummariesInUse } from './agent-summaries'
import {
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
  displaySlug,
  isMintedAgentId,
} from '@shared/lib/utils/file-storage'
import {
  AgentFrontmatter,
  AgentConfig,
  CreateAgentInput,
  UpdateAgentInput,
  DEFAULT_AGENT_INSTRUCTIONS,
} from '@shared/lib/types/agent'
import type { ApiAgent } from '@shared/lib/types/api'
import { agentAvatarSchema, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import { workspaceAgentDescriptionSchema, workspaceAgentNameSchema } from './agent-identity-schema'
import { getTeamBrain } from '@shared/lib/config/settings'
import {
  CONFIG_DOCS,
  agentCatalog,
  agentRegistry,
  identityFromInstructions,
  type AgentIdentityChanges,
  type AgentLiveSummary,
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
  container: Pick<AgentLiveSummary['container'], 'status' | 'port' | 'healthWarnings' | 'stale'>,
  instructions?: string,
): ApiAgent {
  const { status, port, healthWarnings, stale } = container
  return {
    ...newAgentResponse(record, instructions),
    status,
    containerPort: port,
    ...(healthWarnings.length > 0 ? { healthWarnings } : {}),
    ...(stale ? { stale: true } : {}),
  }
}

/** The API shape of an agent that was just created: stopped, and with no health to report yet. */
function newAgentResponse(record: AgentRecord, instructions?: string): ApiAgent {
  const teamBrain = getTeamBrain()
  return {
    slug: record.slug,
    displaySlug: displaySlug(record.name, record.slug),
    name: record.name,
    ...(teamBrain?.agentSlug === record.slug ? { teamBrain: { volumeId: teamBrain.volumeId } } : {}),
    avatar: record.avatar,
    description: record.description,
    ...(instructions === undefined ? {} : { instructions }),
    createdAt: record.createdAt,
    status: 'stopped',
    containerPort: null,
  }
}

/**
 * The frontmatter the host projects into `AGENTS.md`: the row's identity over
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

interface InstructionsDocument {
  frontmatter: Record<string, unknown>
  body: string
  /** The text as read, for putting back when a later step fails. */
  raw: string
}

async function readInstructionsDocument(slug: string): Promise<InstructionsDocument | null> {
  const content = await agentRegistry.get(slug).config.get('instructions')
  if (content === null) return null
  return { ...parseMarkdownWithFrontmatter<Record<string, unknown>>(content), raw: content }
}

/**
 * The agent's identity lock: every change to an agent's identity, which spans
 * the catalog row and the `AGENTS.md` projection, runs to completion before
 * the next one starts, so two overlapping renames cannot leave the row with
 * one name and the document with the other.
 */
const IDENTITY_LOCK = 'identity'
async function withIdentityLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const { locks } = agentRegistry.get(slug)
  const token = await locks.acquire(IDENTITY_LOCK)
  try {
    return await fn()
  } finally {
    await locks.release(IDENTITY_LOCK, token)
  }
}

/**
 * Change an agent's identity in both places, the projection first: a
 * document write that fails leaves the old identity everywhere, and a row
 * update that fails afterwards puts the old document back. The caller has
 * read the document and holds the identity lock.
 */
async function commitIdentity(
  record: AgentRecord,
  changes: AgentIdentityChanges,
  document: InstructionsDocument | null,
  body: string,
): Promise<AgentRecord | null> {
  const next: AgentRecord = { ...record }
  if (changes.name !== undefined) next.name = changes.name
  if (changes.description !== undefined) {
    if (changes.description === null) delete next.description
    else next.description = changes.description
  }
  const actor = agentRegistry.get(record.slug)
  await actor.config.put(
    'instructions',
    serializeMarkdownWithFrontmatter(projectedFrontmatter(next, document?.frontmatter ?? {}), body),
  )
  try {
    return await agentCatalog.update(record.slug, changes)
  } catch (error) {
    // Put the document back as it was: its old text, or its absence, so the
    // rejected identity is not left behind in a file the row does not match.
    if (document) await actor.config.put('instructions', document.raw).catch(() => undefined)
    else await actor.files.delete(CONFIG_DOCS.instructions.path).catch(() => undefined)
    throw error
  }
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
 * `AGENTS.md` cannot be read is an error, not a missing agent.
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
  // The cached container status: no docker process is spawned.
  const live = await actor.live()
  const record = (await agentCatalog.get(slug))!
  const base = toApiAgent(record, live.container, agent.instructions)

  // Routes that either discard the body (/start) or immediately run the richer
  // enrichAgentsWithSummary pass (list/detail) skip this otherwise-duplicate
  // O(session-count) stat scan; standalone callers keep the enriched default.
  if (options.includeSummary === false) return base

  // The same session flags as the list endpoint: pending proxy reviews need
  // the user whether or not a session waits on them.
  const sessionSummary = await actor.sessions.summary()
  return {
    ...base,
    hasActiveSessions: live.activeSessionIds.length > 0,
    hasSessionsAwaitingInput: live.awaitingSessionIds.length > 0 || live.pendingReviews.length > 0,
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

  if (storedAgentSummariesInUse()) {
    const summaries = await readAgentSummaries(records.map((record) => record.slug))
    return records.map((record) => toApiAgent(record, (summaries.get(record.slug) ?? NO_AGENT_SUMMARY).container))
  }

  // The cached container statuses: no docker process is spawned.
  return Promise.all(records.map(async (record) => toApiAgent(record, (await agentRegistry.get(record.slug).live()).container)))
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new agent (returns API format with stopped status)
 */
export async function createAgent(input: CreateAgentInput): Promise<ApiAgent> {
  const { name: rawName, description, instructions, id, avatar } = input
  const name = String(rawName)
  const body = instructions || DEFAULT_AGENT_INSTRUCTIONS
  const record = await writeNewAgent({ name, description: description || undefined, id, avatar }, body)
  return newAgentResponse(record, body)
}

/**
 * Mint a slug, record the agent, then write its workspace. The row goes first
 * so that a crash in between leaves an agent that is listed (with no
 * instructions yet) and can be deleted, never a workspace on disk that
 * nothing lists. A workspace write that fails takes the row with it.
 */
async function writeNewAgent(
  identity: { name: string; description?: string; id?: string; avatar?: AgentAvatar },
  body: string,
): Promise<AgentRecord> {
  // An opaque id — the name no longer feeds the folder, so the "Untitled"
  // promptless-create flow can't poison it.
  const slug = identity.id ?? await agentCatalog.mint()
  if (identity.id !== undefined) {
    if (!isMintedAgentId(identity.id)) throw new AgentIdError('invalid', 'An agent id must be 10 lowercase letters or digits')
    if (!(await agentCatalog.available(identity.id))) throw new AgentIdError('taken', 'That agent id is already in use')
  }
  const createdAt = new Date()
  const record = await agentCatalog.insert({ slug, name: identity.name, description: identity.description, createdAt, avatar: identity.avatar })

  const frontmatter: AgentFrontmatter = { name: identity.name, createdAt: createdAt.toISOString() }
  if (identity.description) {
    frontmatter.description = identity.description
  }
  try {
    const actor = agentRegistry.get(slug)
    await actor.files.mkdir('')
    await actor.config.put('instructions', serializeMarkdownWithFrontmatter(frontmatter, body))
  } catch (error) {
    await agentCatalog.remove(slug).catch(() => undefined)
    throw error
  }

  return record
}

/**
 * Update agent metadata and/or instructions (returns API format)
 */
export async function updateAgent(
  slug: string,
  updates: UpdateAgentInput
): Promise<ApiAgent | null> {
  return withIdentityLock(slug, async () => {
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

    // Rewrite the document: the new body if given, and the identity
    // projection either way, so the agent sees its new name; then the row.
    const document = await readInstructionsDocument(slug)
    const body = updates.instructions !== undefined ? updates.instructions : document?.body ?? ''
    const updated = await commitIdentity(record, changes, document, body)
    if (!updated) return null

    // The runtime's own status, with the cached health beside it.
    const actor = agentRegistry.get(slug)
    const [info, live] = await Promise.all([actor.container.info(), actor.live()])
    return toApiAgent(updated, { ...live.container, status: info.status, port: info.port }, body)
  })
}

/** Appearance lives entirely in the catalog, so changing it never reads a workspace. */
export async function updateAgentAvatar(slug: string, input: AgentAvatar): Promise<AgentAvatar | null> {
  const avatar = agentAvatarSchema.parse(input)
  const record = await agentCatalog.update(slug, { avatar })
  return record?.avatar ?? null
}

/**
 * Rewrite the identity projection in an agent's `AGENTS.md` from its catalog
 * row, keeping the document's other frontmatter keys and its body. For after
 * something else has replaced the document, such as a template update.
 */
export async function writeAgentIdentityProjection(slug: string): Promise<void> {
  await withIdentityLock(slug, async () => {
    const record = await agentCatalog.get(slug)
    if (!record) return
    const document = await readInstructionsDocument(slug)
    if (!document) return
    await writeProjection(record, document)
  })
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
 * Take an agent's name and description from the `AGENTS.md` its workspace
 * now holds (an imported template, an installed skillset agent), then write
 * the projection back. `name` overrides whatever the document carries; a
 * document without a name keeps the row's. The creation date stays the row's.
 */
export async function adoptAgentIdentityFromWorkspace(
  slug: string,
  overrides: { name?: string } = {},
): Promise<AgentRecord | null> {
  return withIdentityLock(slug, async () => {
    const record = await agentCatalog.get(slug)
    if (!record) return null
    // One read of the document serves both the adoption and the projection.
    const document = await readInstructionsDocument(slug)
    const carried = document === null ? {} : identityFromInstructions(document.raw)
    const name = overrides.name?.trim() || carried.name || record.name
    const description = carried.description ?? record.description ?? null
    if (document === null) {
      // Nothing to project into: the row alone.
      return (await agentCatalog.update(slug, { name, description })) ?? record
    }
    return commitIdentity(record, { name, description }, document, document.body)
  })
}

/**
 * Take the name and description the agent wrote into its own `AGENTS.md`
 * frontmatter into the row. A missing, blank or invalid field leaves that
 * column alone. Returns the fields that changed.
 */
export async function syncAgentIdentityFromWorkspace(slug: string): Promise<Array<'name' | 'description'>> {
  return withIdentityLock(slug, async () => {
    const record = await agentCatalog.get(slug)
    if (!record) return []
    const document = await readInstructionsDocument(slug)
    if (!document) return []
    const carried = identityFromInstructions(document.raw)
    const name = workspaceAgentNameSchema.safeParse(carried.name)
    const description = workspaceAgentDescriptionSchema.safeParse(carried.description)
    const changes: { name?: string; description?: string } = {}
    if (name.success && name.data !== record.name) changes.name = name.data
    if (description.success && description.data !== record.description) changes.description = description.data
    const fields = Object.keys(changes) as Array<'name' | 'description'>
    if (fields.length > 0) await agentCatalog.update(slug, changes)
    return fields
  })
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
/** A caller-chosen agent id that cannot be used: malformed, or already in use. */
export class AgentIdError extends Error {
  constructor(readonly code: 'invalid' | 'taken', message: string) {
    super(message)
    this.name = 'AgentIdError'
  }
}

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
  await agentRegistry.evict(slug)

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
  // A basic AGENTS.md (may be overwritten by template)
  const record = await writeNewAgent({ name }, DEFAULT_AGENT_INSTRUCTIONS)
  return newAgentResponse(record)
}

/**
 * Check if an agent exists
 */
export async function agentExists(slug: string): Promise<boolean> {
  return agentCatalog.exists(slug)
}

/**
 * Get raw AGENTS.md content (for editor)
 */
export async function getAgentInstructionsContent(slug: string): Promise<string | null> {
  return agentRegistry.get(slug).config.get('instructions')
}

/**
 * Set raw AGENTS.md content (from editor)
 */
export async function setAgentInstructionsContent(
  slug: string,
  content: string
): Promise<void> {
  await agentRegistry.get(slug).config.put('instructions', content)
}
