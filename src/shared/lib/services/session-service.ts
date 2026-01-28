/**
 * Session Service
 *
 * File-based operations for sessions.
 * Sessions are stored as JSONL files by Claude Code SDK.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  getAgentsDir,
  getAgentSessionsDir,
  getAgentSessionMetadataPath,
  getSessionJsonlPath,
  listDirectories,
  directoryExists,
  fileExists,
  readFileOrNull,
  writeFile,
  readJsonlFile,
  ensureDirectory,
} from '@shared/lib/utils/file-storage'
import {
  SessionInfo,
  SessionMetadata,
  SessionMetadataMap,
  JsonlEntry,
  JsonlMessageEntry,
} from '@shared/lib/types/agent'

// ============================================================================
// Session Metadata (custom names, starred status)
// ============================================================================

/**
 * Read session metadata map from file
 */
async function readSessionMetadata(agentSlug: string): Promise<SessionMetadataMap> {
  const metadataPath = getAgentSessionMetadataPath(agentSlug)
  const content = await readFileOrNull(metadataPath)

  if (!content) {
    return {}
  }

  try {
    return JSON.parse(content) as SessionMetadataMap
  } catch {
    console.warn(`Failed to parse session metadata for agent ${agentSlug}`)
    return {}
  }
}

/**
 * Write session metadata map to file
 */
async function writeSessionMetadata(
  agentSlug: string,
  metadata: SessionMetadataMap
): Promise<void> {
  const metadataPath = getAgentSessionMetadataPath(agentSlug)
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2))
}

/**
 * Update metadata for a single session
 */
export async function updateSessionMetadata(
  agentSlug: string,
  sessionId: string,
  updates: Partial<SessionMetadata>
): Promise<void> {
  const metadata = await readSessionMetadata(agentSlug)

  metadata[sessionId] = {
    ...metadata[sessionId],
    ...updates,
  }

  await writeSessionMetadata(agentSlug, metadata)
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
  name?: string
): Promise<void> {
  const metadata = await readSessionMetadata(agentSlug)

  metadata[sessionId] = {
    name: name || 'New Session',
    createdAt: new Date().toISOString(),
  }

  await writeSessionMetadata(agentSlug, metadata)
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
 * Parse session info from JSONL entries
 */
function parseSessionInfo(
  sessionId: string,
  agentSlug: string,
  entries: JsonlEntry[],
  metadata?: SessionMetadata
): SessionInfo {
  const messages = entries.filter(isMessageEntry)

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

// ============================================================================
// Session Operations
// ============================================================================

/**
 * List all sessions for an agent
 */
export async function listSessions(agentSlug: string): Promise<SessionInfo[]> {
  const sessionsDir = getAgentSessionsDir(agentSlug)

  // Read session metadata (includes newly created sessions without JSONL yet)
  const metadata = await readSessionMetadata(agentSlug)

  // Track which sessions we've processed
  const processedSessionIds = new Set<string>()
  const sessions: SessionInfo[] = []

  // First, process sessions with JSONL files
  if (await directoryExists(sessionsDir)) {
    const files = await fs.promises.readdir(sessionsDir)
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

    for (const file of jsonlFiles) {
      const sessionId = path.basename(file, '.jsonl')
      const jsonlPath = path.join(sessionsDir, file)
      processedSessionIds.add(sessionId)

      try {
        // Read JSONL file
        const entries = await readJsonlFile<JsonlEntry>(jsonlPath)

        // Skip empty JSONL files that aren't registered in metadata
        // These are typically created by Claude SDK for subagent directories
        if (entries.length === 0 && !metadata[sessionId]) {
          continue
        }

        const sessionInfo = parseSessionInfo(
          sessionId,
          agentSlug,
          entries,
          metadata[sessionId]
        )
        sessions.push(sessionInfo)
      } catch (error) {
        console.warn(`Failed to parse session ${sessionId}:`, error)
        // Skip malformed sessions
      }
    }
  }

  // Then, add sessions from metadata that don't have JSONL files yet
  // (newly created sessions where Claude hasn't written yet)
  for (const [sessionId, sessionMeta] of Object.entries(metadata)) {
    if (!processedSessionIds.has(sessionId) && sessionMeta.createdAt) {
      const createdAt = new Date(sessionMeta.createdAt)
      sessions.push({
        id: sessionId,
        agentSlug,
        name: sessionMeta.name || 'New Session',
        createdAt,
        lastActivityAt: createdAt,
        messageCount: 0,
      })
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

  if (!(await fileExists(jsonlPath))) {
    return null
  }

  const metadata = await getSessionMetadata(agentSlug, sessionId)
  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)

  return parseSessionInfo(sessionId, agentSlug, entries, metadata || undefined)
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
  return entries.filter(isMessageEntry)
}

/**
 * Delete a session (removes JSONL file and metadata)
 */
export async function deleteSession(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  if (!(await fileExists(jsonlPath))) {
    return false
  }

  // Remove JSONL file
  await fs.promises.unlink(jsonlPath)

  // Remove from metadata
  const metadata = await readSessionMetadata(agentSlug)
  if (metadata[sessionId]) {
    delete metadata[sessionId]
    await writeSessionMetadata(agentSlug, metadata)
  }

  return true
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

/**
 * Get all sessions created by a scheduled task
 */
export async function getSessionsByScheduledTask(
  agentSlug: string,
  scheduledTaskId: string
): Promise<SessionInfo[]> {
  // Get all sessions and their metadata
  const allSessions = await listSessions(agentSlug)
  const metadata = await readSessionMetadata(agentSlug)

  // Filter sessions that were created by this scheduled task
  return allSessions.filter((session) => {
    const sessionMeta = metadata[session.id]
    return sessionMeta?.scheduledTaskId === scheduledTaskId
  })
}
