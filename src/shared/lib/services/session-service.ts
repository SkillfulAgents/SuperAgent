/**
 * Session Service
 *
 * File-based operations for sessions.
 * Sessions are stored as JSONL files by Claude Code SDK.
 */

import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'
import {
  getAgentsDir,
  getAgentSessionsDir,
  getAgentSessionMetadataPath,
  getSessionJsonlPath,
  listDirectories,
  directoryExists,
  fileExists,
  writeFile,
  writeJsonFileAtomic,
  readJsonFileStrict,
  withFileLock,
  CorruptFileError,
  readJsonlFile,
  ensureDirectory,
} from '@shared/lib/utils/file-storage'
import { sessionMetadataMapSchema } from './session-metadata-schema'
import {
  SessionInfo,
  SessionMetadata,
  SessionMetadataMap,
  JsonlEntry,
  JsonlMessageEntry,
  JsonlSystemEntry,
  JsonlAttachmentEntry,
  ContentBlock,
} from '@shared/lib/types/agent'
import { captureException } from '@shared/lib/error-reporting'

// ============================================================================
// Session Metadata (custom names, starred status)
// ============================================================================

/**
 * Strict read of the session metadata map: returns `{}` ONLY when the file is
 * absent (ENOENT); a present-but-unreadable file (torn/corrupt/IO error) THROWS.
 *
 * This is what the read-modify-write helper below uses, so a transiently
 * unreadable file aborts the write instead of being overwritten with a near-empty
 * map — the permanent-data-loss mechanism. Do NOT use this on read-only
 * display paths; use {@link readSessionMetadata}, which degrades gracefully.
 */
async function readSessionMetadataStrict(agentSlug: string): Promise<SessionMetadataMap> {
  const metadataPath = getAgentSessionMetadataPath(agentSlug)
  const parsed = await readJsonFileStrict(metadataPath, sessionMetadataMapSchema, {})
  return parsed as SessionMetadataMap
}

/**
 * Read session metadata map for READ-ONLY consumers (listing, display, lookup).
 *
 * Behaviour preserved from before, plus loud reporting: missing file → `{}`;
 * corrupt/torn file → log + capture + `{}` (so the sessions view degrades to
 * auto-titles instead of crashing). Returning `{}` here is safe ONLY because
 * these callers never write — the destructive overwrite came from a write that
 * followed a swallowed bad read, and writes now go through
 * {@link mutateSessionMetadata}, which re-throws on corruption. A non-ENOENT IO
 * error still propagates (matches the original `readFileOrNull` behaviour).
 */
export async function readSessionMetadata(agentSlug: string): Promise<SessionMetadataMap> {
  try {
    return await readSessionMetadataStrict(agentSlug)
  } catch (error) {
    if (error instanceof CorruptFileError) {
      console.error(
        `Corrupt session metadata for agent ${agentSlug}; using empty map for read-only access (NOT overwriting)`,
        error
      )
      captureException(error, {
        tags: { area: 'session-metadata', op: 'read' },
        extra: { agentSlug },
      })
      return {}
    }
    throw error
  }
}

/**
 * Serialized read-modify-write of an agent's session metadata map.
 *
 * Holds a per-file in-process lock so concurrent mutations can't interleave
 * (lost-update protection), re-reads fresh under the lock with the STRICT reader
 * (so a corrupt file throws and aborts the write rather than clobbering), and
 * persists with an atomic temp-file+rename (so an interrupted write never leaves
 * a torn file). The `mutator` returns `false` to signal "no change" and skip the
 * write entirely (avoids materializing an empty file for a no-op).
 */
async function mutateSessionMetadata(
  agentSlug: string,
  mutator: (metadata: SessionMetadataMap) => boolean | void
): Promise<void> {
  const metadataPath = getAgentSessionMetadataPath(agentSlug)
  await withFileLock(metadataPath, async () => {
    const metadata = await readSessionMetadataStrict(agentSlug)
    const changed = mutator(metadata)
    if (changed === false) return
    await writeJsonFileAtomic(metadataPath, metadata)
  })
}

/**
 * Update metadata for a single session
 */
export async function updateSessionMetadata(
  agentSlug: string,
  sessionId: string,
  updates: Partial<SessionMetadata>
): Promise<void> {
  await mutateSessionMetadata(agentSlug, (metadata) => {
    metadata[sessionId] = {
      ...metadata[sessionId],
      ...updates,
    }
  })
}

/**
 * Get metadata for a single session
 */
export async function getSessionMetadata(
  agentSlug: string,
  sessionId: string
): Promise<SessionMetadata | null> {
  const metadata = await readSessionMetadata(agentSlug)
  return metadata[sessionId] || null
}

/**
 * Register a new session (called immediately when session is created)
 * This ensures the session appears in listings before the JSONL file exists
 */
export async function registerSession(
  agentSlug: string,
  sessionId: string,
  name?: string,
  initialMetadata?: Partial<SessionMetadata>,
): Promise<void> {
  await mutateSessionMetadata(agentSlug, (metadata) => {
    metadata[sessionId] = {
      ...initialMetadata,
      name: name || 'New Session',
      createdAt: new Date().toISOString(),
    }
  })
}

/**
 * Check if a session is registered (exists in metadata)
 */
export async function isSessionRegistered(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  const metadata = await readSessionMetadata(agentSlug)
  return sessionId in metadata
}

// ============================================================================
// Session JSONL Parsing
// ============================================================================

/**
 * Check if a JSONL entry is a message (not a file-history-snapshot)
 */
function isMessageEntry(entry: JsonlEntry): entry is JsonlMessageEntry {
  return entry.type === 'user' || entry.type === 'assistant'
}

/**
 * Convert a `queued_command` attachment entry into a synthetic user message
 * entry. The CLI records user messages that arrive mid-turn (queued/steering
 * input) this way instead of as regular `user` entries, so without this
 * conversion queued messages would be invisible in the transcript even though
 * the agent acted on them. Returns the entry unchanged when it isn't a
 * user-typed queued command (task notifications, meta/system injections).
 */
function normalizeQueuedCommandEntry(entry: JsonlEntry): JsonlEntry {
  if (entry.type !== 'attachment') return entry
  const { attachment } = entry as JsonlAttachmentEntry
  if (
    !attachment ||
    attachment.type !== 'queued_command' ||
    attachment.commandMode !== 'prompt' ||
    attachment.isMeta ||
    attachment.prompt === undefined
  ) {
    return entry
  }
  return {
    type: 'user',
    // source_uuid is the CLI's queue-entry id; prefer it since it's also the
    // uuid the SDK uses when replaying this message on session resume.
    uuid: attachment.source_uuid ?? entry.uuid,
    parentUuid: entry.parentUuid ?? null,
    sessionId: entry.sessionId ?? '',
    timestamp: entry.timestamp,
    message: {
      role: 'user',
      content: attachment.prompt,
    },
    isQueuedCommand: true,
  } satisfies JsonlMessageEntry
}

/**
 * Parse session info from JSONL entries
 */
function parseSessionInfo(
  sessionId: string,
  agentSlug: string,
  entries: JsonlEntry[],
  metadata?: SessionMetadata
): SessionInfo {
  // Normalize queued_command attachments so mid-turn messages count toward
  // naming, messageCount, and activity timestamps like any other user message.
  const messages = entries.map(normalizeQueuedCommandEntry).filter(isMessageEntry)

  // Get timestamps
  let createdAt = new Date()
  let lastActivityAt = new Date()

  if (messages.length > 0) {
    createdAt = new Date(messages[0].timestamp)
    lastActivityAt = new Date(messages[messages.length - 1].timestamp)
  }

  // Generate name from first user message if no custom name
  let name = metadata?.name || 'New Session'
  if (!metadata?.name && messages.length > 0) {
    const firstUserMessage = messages.find(
      (m) => m.type === 'user' && typeof m.message.content === 'string'
    )
    if (firstUserMessage && typeof firstUserMessage.message.content === 'string') {
      // Use first 50 chars of first message as name
      const content = firstUserMessage.message.content
      name = content.substring(0, 50).trim()
      if (content.length > 50) {
        name += '...'
      }
    }
  }

  return {
    id: sessionId,
    agentSlug,
    name,
    createdAt,
    lastActivityAt,
    messageCount: messages.length,
  }
}

/**
 * Build the SessionInfo for a session that is registered in metadata but whose
 * JSONL transcript doesn't exist on disk yet: a just-created session still
 * settling before the agent has streamed its first message (the transcript is
 * written asynchronously, after the create response returns). Shared by
 * getSession and listSessions so a single-session read and the list agree on a
 * session's existence and fields rather than drifting. Callers gate on
 * `meta.createdAt` — a properly registered session always has it.
 */
function emptySessionFromMetadata(
  sessionId: string,
  agentSlug: string,
  meta: SessionMetadata
): SessionInfo {
  const createdAt = meta.createdAt ? new Date(meta.createdAt) : new Date()
  return {
    id: sessionId,
    agentSlug,
    name: meta.name || 'New Session',
    createdAt,
    lastActivityAt: createdAt,
    messageCount: 0,
  }
}

// ============================================================================
// Session Operations
// ============================================================================

/**
 * Lightweight session summary from filesystem stats only (no JSONL parsing).
 * Returns session IDs, count, and latest activity time.
 */
export async function getSessionSummary(agentSlug: string): Promise<{
  sessionIds: string[]
  sessionCount: number
  lastActivityAt: Date | null
}> {
  const sessionsDir = getAgentSessionsDir(agentSlug)

  if (!(await directoryExists(sessionsDir))) {
    return { sessionIds: [], sessionCount: 0, lastActivityAt: null }
  }

  const files = await fs.promises.readdir(sessionsDir)
  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

  const limit = pLimit(10)
  const stats = await Promise.all(
    jsonlFiles.map((file) => limit(async () => {
      const stat = await fs.promises.stat(path.join(sessionsDir, file))
      return { sessionId: path.basename(file, '.jsonl'), mtimeMs: stat.mtimeMs }
    }))
  )

  let lastActivityAt: Date | null = null
  const sessionIds: string[] = []
  for (const { sessionId, mtimeMs } of stats) {
    sessionIds.push(sessionId)
    if (!lastActivityAt || mtimeMs > lastActivityAt.getTime()) {
      lastActivityAt = new Date(mtimeMs)
    }
  }

  return { sessionIds, sessionCount: jsonlFiles.length, lastActivityAt }
}

/**
 * List all sessions for an agent using file stats and metadata.
 * Does NOT read full JSONL file contents — safe for large session directories.
 */
export async function listSessions(
  agentSlug: string,
  options?: { excludeAutomated?: boolean },
): Promise<SessionInfo[]> {
  const sessionsDir = getAgentSessionsDir(agentSlug)

  // Read session metadata (includes newly created sessions without JSONL yet)
  const metadata = await readSessionMetadata(agentSlug)

  const isAutomated = (sessionId: string) => {
    const meta = metadata[sessionId]
    if (meta?.promotedToInteractive) return false
    return meta?.isScheduledExecution || meta?.isWebhookExecution || meta?.isChatIntegrationSession
  }

  // Track which sessions we've processed
  const processedSessionIds = new Set<string>()
  const sessions: SessionInfo[] = []

  // First, process sessions with JSONL files
  if (await directoryExists(sessionsDir)) {
    const files = await fs.promises.readdir(sessionsDir)
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

    const limit = pLimit(10)
    const statResults = await Promise.all(
      jsonlFiles.map((file) => limit(async () => {
        const sessionId = path.basename(file, '.jsonl')
        const jsonlPath = path.join(sessionsDir, file)
        try {
          const stat = await fs.promises.stat(jsonlPath)
          return { sessionId, stat }
        } catch (error) {
          console.warn(`Failed to stat session ${sessionId}:`, error)
          return null
        }
      }))
    )

    for (const result of statResults) {
      if (!result) continue
      const { sessionId, stat } = result
      processedSessionIds.add(sessionId)

      // Skip empty JSONL files that aren't registered in metadata
      // These are typically created by Claude SDK for subagent directories
      if (stat.size === 0 && !metadata[sessionId]) {
        continue
      }

      // Skip scheduled/webhook sessions when requested
      if (options?.excludeAutomated && isAutomated(sessionId)) {
        continue
      }

      // Prefer metadata createdAt; birthtime is unsupported (epoch 0) on
      // network filesystems like S3 Files / EFS used by the k8s runtime.
      const metaCreatedAt = metadata[sessionId]?.createdAt
      const createdAt = metaCreatedAt
        ? new Date(metaCreatedAt)
        : stat.birthtimeMs > 0
          ? stat.birthtime
          : new Date(stat.mtimeMs)

      sessions.push({
        id: sessionId,
        agentSlug,
        name: metadata[sessionId]?.name || 'New Session',
        createdAt,
        lastActivityAt: new Date(stat.mtimeMs),
        messageCount: 0,
      })
    }
  }

  // Then, add sessions from metadata that don't have JSONL files yet
  // (newly created sessions where the agent hasn't streamed yet)
  for (const [sessionId, sessionMeta] of Object.entries(metadata)) {
    if (!processedSessionIds.has(sessionId) && sessionMeta.createdAt) {
      // Skip scheduled/webhook sessions when requested
      if (options?.excludeAutomated && isAutomated(sessionId)) {
        continue
      }

      sessions.push(emptySessionFromMetadata(sessionId, agentSlug, sessionMeta))
    }
  }

  // Sort by last activity, newest first
  sessions.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())

  return sessions
}

/**
 * Get a single session's info
 */
export async function getSession(
  agentSlug: string,
  sessionId: string
): Promise<SessionInfo | null> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  const metadata = await getSessionMetadata(agentSlug, sessionId)

  if (await fileExists(jsonlPath)) {
    const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
    return parseSessionInfo(sessionId, agentSlug, entries, metadata || undefined)
  }

  // No transcript yet, but the session is registered → it was just created and
  // the agent hasn't streamed its first message (which is what writes the
  // JSONL). Report it as an empty session, matching listSessions, instead of
  // 404ing a session that genuinely exists. Registration (the metadata write)
  // is synchronous in the create path, so by the time a client navigates to a
  // new session it is always readable here. A genuine 404 means the session is
  // in neither store — truly missing.
  if (metadata?.createdAt) {
    return emptySessionFromMetadata(sessionId, agentSlug, metadata)
  }

  return null
}

/**
 * Get all messages from a session
 */
export async function getSessionMessages(
  agentSlug: string,
  sessionId: string
): Promise<JsonlMessageEntry[]> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  if (!(await fileExists(jsonlPath))) {
    return []
  }

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  return entries.map(normalizeQueuedCommandEntry).filter(isMessageEntry)
}

/**
 * Check if a JSONL entry is a message or compact boundary (for display)
 */
function isMessageOrSystemDisplayEntry(
  entry: JsonlEntry
): entry is JsonlMessageEntry | JsonlSystemEntry {
  if (entry.type === 'user' || entry.type === 'assistant') return true
  if (entry.type === 'system') {
    const subtype = (entry as JsonlSystemEntry).subtype
    return subtype === 'compact_boundary' || subtype === 'memory_recall'
  }
  return false
}

/**
 * Get all messages from a session including compact boundary markers
 */
export async function getSessionMessagesWithCompact(
  agentSlug: string,
  sessionId: string
): Promise<(JsonlMessageEntry | JsonlSystemEntry)[]> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  if (!(await fileExists(jsonlPath))) {
    return []
  }

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  return entries.map(normalizeQueuedCommandEntry).filter(isMessageOrSystemDisplayEntry)
}

/**
 * Delete a session (removes JSONL file and metadata)
 */
export async function deleteSession(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  const jsonlExisted = await fileExists(jsonlPath)

  if (jsonlExisted) {
    try {
      await fs.promises.unlink(jsonlPath)
    } catch (error) {
      // The file existed when we checked, so this is a genuine failure
      // (permissions, lock, I/O error), not a benign "already gone". Report it
      // and bail WITHOUT touching metadata — deleting the metadata while the
      // JSONL remains would orphan the transcript (it would re-surface as an
      // unnamed session in listings).
      captureException(error, {
        tags: { area: 'session-delete', op: 'unlink' },
        extra: { agentSlug, sessionId },
      })
      throw error
    }
  } else {
    // No transcript to remove — e.g. it was deleted by the CLI's retention
    // cleanup while the metadata entry lingered. Skip the unlink (an unlink
    // here would fail with ENOENT) and just clear the dangling metadata.
    console.warn(
      `deleteSession: no JSONL transcript for ${agentSlug}/${sessionId}; removing metadata only`
    )
  }

  // Remove from metadata regardless, so dangling entries can be cleared. Done
  // under the serialized read-modify-write so a concurrent registration/rename
  // can't lose updates, and a corrupt metadata file aborts (throws) rather than
  // being rewritten without this entry's siblings.
  let hadMetadata = false
  await mutateSessionMetadata(agentSlug, (metadata) => {
    hadMetadata = metadata[sessionId] !== undefined
    if (!hadMetadata) return false // nothing to delete — skip the write
    delete metadata[sessionId]
    return true
  })

  return jsonlExisted || hadMetadata
}

/**
 * Delete multiple sessions in a single batch (one metadata read/write cycle).
 * Returns the IDs of sessions whose JSONL files were actually removed.
 */
export async function deleteSessionsBatch(
  agentSlug: string,
  sessionIds: string[]
): Promise<string[]> {
  if (sessionIds.length === 0) return []

  const deleted: string[] = []

  for (const sessionId of sessionIds) {
    const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
    try {
      await fs.promises.unlink(jsonlPath)
      deleted.push(sessionId)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        deleted.push(sessionId)
      } else {
        // Keep this session's metadata: its transcript is still on disk.
        console.error(`Failed to delete session file ${sessionId}:`, error)
      }
    }
  }

  // Drop metadata only for the sessions whose JSONL was actually removed, in a
  // single serialized + atomic read-modify-write.
  if (deleted.length > 0) {
    await mutateSessionMetadata(agentSlug, (metadata) => {
      let changed = false
      for (const sessionId of deleted) {
        if (metadata[sessionId] !== undefined) {
          delete metadata[sessionId]
          changed = true
        }
      }
      return changed
    })
  }

  return deleted
}

/**
 * Update session name
 */
export async function updateSessionName(
  agentSlug: string,
  sessionId: string,
  name: string
): Promise<void> {
  await updateSessionMetadata(agentSlug, sessionId, { name })
}

/**
 * Check if a session exists
 */
export async function sessionExists(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  return fileExists(jsonlPath)
}

// ============================================================================
// Session Directory Management
// ============================================================================

/**
 * Ensure session directory exists for an agent
 * This is called when starting a container to ensure Claude has a place to write
 */
export async function ensureSessionsDirectory(agentSlug: string): Promise<void> {
  const sessionsDir = getAgentSessionsDir(agentSlug)
  await ensureDirectory(sessionsDir)
}

// ============================================================================
// Session Lookup (for routes without agent context)
// ============================================================================

/**
 * Find which agent a session belongs to by scanning all agents
 * Returns { agentSlug, sessionInfo } or null if not found
 */
export async function findSessionAcrossAgents(
  sessionId: string
): Promise<{ agentSlug: string; session: SessionInfo } | null> {
  const agentsDir = getAgentsDir()

  // List all agent directories
  const slugs = await listDirectories(agentsDir)

  for (const slug of slugs) {
    const session = await getSession(slug, sessionId)
    if (session) {
      return { agentSlug: slug, session }
    }
  }

  return null
}

// ============================================================================
// Message Removal
// ============================================================================

/**
 * Remove an entire message (and its associated tool results) from a session's JSONL file.
 *
 * For assistant messages: removes all JSONL entries sharing the same message.id,
 * plus any user-type entries containing tool_result blocks for those tool calls.
 * For user messages: removes the single entry matching the uuid.
 */
export async function removeMessage(
  agentSlug: string,
  sessionId: string,
  messageUuid: string
): Promise<boolean> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  if (!(await fileExists(jsonlPath))) return false

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)

  // Find the target entry by id. Regular messages match by top-level uuid;
  // queued (mid-turn) messages surface in the UI with id = the queued_command
  // attachment's source_uuid (see normalizeQueuedCommandEntry), so match the
  // underlying attachment entry as well.
  const matchesTargetId = (e: JsonlEntry): boolean =>
    ('uuid' in e && e.uuid === messageUuid) ||
    (e.type === 'attachment' && (e as JsonlAttachmentEntry).attachment?.source_uuid === messageUuid)

  const target = entries.find(matchesTargetId)
  if (!target) return false

  // Collect message IDs and tool_use IDs to remove
  const messageIdsToRemove = new Set<string>()
  const toolUseIdsToRemove = new Set<string>()

  if (target.type === 'assistant' && target.message.id) {
    // Remove all entries for this assistant message (they share message.id)
    messageIdsToRemove.add(target.message.id)

    // Collect tool_use IDs from all entries with this message.id
    for (const entry of entries) {
      if (!('message' in entry)) continue
      const e = entry as JsonlMessageEntry
      if (e.type === 'assistant' && e.message.id === target.message.id) {
        const content = e.message.content
        if (Array.isArray(content)) {
          for (const block of content as ContentBlock[]) {
            if (block.type === 'tool_use') {
              toolUseIdsToRemove.add(block.id)
            }
          }
        }
      }
    }
  }

  // Filter entries
  const filtered = entries.filter((entry) => {
    // Remove the target entry (user message or queued_command attachment)
    if (matchesTargetId(entry)) return false
    if (!('uuid' in entry)) return true // keep non-message entries
    const e = entry as JsonlMessageEntry
    if (e.type === 'assistant' && e.message.id && messageIdsToRemove.has(e.message.id)) return false

    // Remove tool_result user entries referencing removed tool calls
    if (e.type === 'user' && toolUseIdsToRemove.size > 0) {
      const content = e.message.content
      if (Array.isArray(content)) {
        const blocks = content as ContentBlock[]
        if (blocks.every((b) => b.type === 'tool_result' && toolUseIdsToRemove.has(b.tool_use_id))) {
          return false
        }
      }
    }

    return true
  })

  // Write back
  const jsonl = filtered.map((e) => JSON.stringify(e)).join('\n') + (filtered.length > 0 ? '\n' : '')
  await writeFile(jsonlPath, jsonl)
  return true
}

/**
 * Remove a specific tool call (and its result) from a session's JSONL file.
 *
 * Removes the tool_use content block from the assistant entry and the
 * corresponding tool_result user entry. If the assistant entry has no
 * remaining content blocks, the entire entry is removed.
 */
export async function removeToolCall(
  agentSlug: string,
  sessionId: string,
  toolCallId: string
): Promise<boolean> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  if (!(await fileExists(jsonlPath))) return false

  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  let found = false

  // Process entries: remove the tool_use block and tool_result entries
  const filtered: JsonlEntry[] = []

  for (const entry of entries) {
    if (!('message' in entry)) {
      filtered.push(entry)
      continue
    }
    const e = entry as JsonlMessageEntry

    // Remove tool_result user entries for this tool call
    if (e.type === 'user' && Array.isArray(e.message.content)) {
      const blocks = e.message.content as ContentBlock[]
      const remaining = blocks.filter(
        (b) => !(b.type === 'tool_result' && b.tool_use_id === toolCallId)
      )
      if (remaining.length < blocks.length) {
        found = true
        if (remaining.length === 0) continue // drop entire entry
        filtered.push({ ...e, message: { ...e.message, content: remaining } })
        continue
      }
    }

    // Remove tool_use block from assistant entries
    if (e.type === 'assistant' && Array.isArray(e.message.content)) {
      const blocks = e.message.content as ContentBlock[]
      const remaining = blocks.filter(
        (b) => !(b.type === 'tool_use' && b.id === toolCallId)
      )
      if (remaining.length < blocks.length) {
        found = true
        if (remaining.length === 0) continue // drop entire entry
        filtered.push({ ...e, message: { ...e.message, content: remaining } })
        continue
      }
    }

    filtered.push(entry)
  }

  if (!found) return false

  const jsonl = filtered.map((e) => JSON.stringify(e)).join('\n') + (filtered.length > 0 ? '\n' : '')
  await writeFile(jsonlPath, jsonl)
  return true
}

/**
 * Get sessions matching a metadata predicate.
 * Reads metadata first to find matching session IDs, then only stats those files
 * instead of loading all sessions for the agent.
 */
async function getSessionsByMetadata(
  agentSlug: string,
  predicate: (meta: SessionMetadata) => boolean,
): Promise<SessionInfo[]> {
  const metadata = await readSessionMetadata(agentSlug)

  // Find matching session IDs from metadata (fast — no filesystem I/O)
  const matchingIds: string[] = []
  for (const [sessionId, meta] of Object.entries(metadata)) {
    if (predicate(meta)) matchingIds.push(sessionId)
  }
  if (matchingIds.length === 0) return []

  // Only stat the matching JSONL files
  const sessions: SessionInfo[] = []
  for (const sessionId of matchingIds) {
    const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
    try {
      const stat = await fs.promises.stat(jsonlPath)
      sessions.push({
        id: sessionId,
        agentSlug,
        name: metadata[sessionId]?.name || 'New Session',
        createdAt: stat.birthtime,
        lastActivityAt: new Date(stat.mtimeMs),
        messageCount: 0,
      })
    } catch {
      // JSONL doesn't exist yet — use metadata createdAt
      sessions.push({
        id: sessionId,
        agentSlug,
        name: metadata[sessionId]?.name || 'New Session',
        createdAt: new Date(metadata[sessionId]?.createdAt || Date.now()),
        lastActivityAt: new Date(metadata[sessionId]?.createdAt || Date.now()),
        messageCount: 0,
      })
    }
  }

  return sessions
}

/**
 * Get all sessions created by a scheduled task.
 */
export async function getSessionsByScheduledTask(
  agentSlug: string,
  scheduledTaskId: string
): Promise<SessionInfo[]> {
  return getSessionsByMetadata(agentSlug, (meta) => meta.scheduledTaskId === scheduledTaskId)
}

/**
 * Get the session for a specific scheduled task execution slot.
 */
export async function getSessionForScheduledExecution(
  agentSlug: string,
  scheduledTaskId: string,
  scheduledExecutionAt: Date,
): Promise<SessionInfo | null> {
  const executionAt = scheduledExecutionAt.toISOString()
  const sessions = await getSessionsByMetadata(
    agentSlug,
    (meta) =>
      meta.isScheduledExecution === true &&
      meta.scheduledTaskId === scheduledTaskId &&
      meta.scheduledExecutionAt === executionAt,
  )

  return sessions[0] ?? null
}

/**
 * Get all sessions that were spawned by a webhook trigger.
 */
export async function getSessionsByWebhookTrigger(
  agentSlug: string,
  webhookTriggerId: string
): Promise<SessionInfo[]> {
  return getSessionsByMetadata(agentSlug, (meta) => meta.webhookTriggerId === webhookTriggerId)
}
