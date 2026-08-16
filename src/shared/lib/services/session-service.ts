/**
 * Session Service
 *
 * File-based operations for sessions.
 * Sessions are stored as JSONL files by Claude Code SDK.
 */

import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'
import { z } from 'zod'
import {
  getAgentsDir,
  getAgentSessionsDir,
  getAgentSessionMetadataPath,
  getSessionJsonlPath,
  listDirectories,
  directoryExists,
  fileExists,
  writeJsonFileAtomic,
  readJsonFileStrict,
  withFileLock,
  CorruptFileError,
  readJsonlFile,
  streamJsonlFile,
  readJsonlTailLines,
  parseJsonl,
  streamFileLines,
  parseJsonlLine,
  writeFileAtomicStream,
  ensureDirectory,
} from '@shared/lib/utils/file-storage'
import { transformMessages, type TransformedItem } from '@shared/lib/utils/message-transform'
import { findDeltaWindowStart } from '@shared/lib/messages-delta'
import { sessionMetadataMapSchema } from './session-metadata-schema'
import { isHiddenAutomatedSession } from './session-visibility'
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
import {
  getSessionSummaryCacheSlot,
  invalidateSessionSummaryCache,
  recordSessionActivity,
  removeSessionFromSummaryCache,
  SESSION_SUMMARY_CACHE_TTL_MS,
  type SessionSummaryCacheValue,
} from './session-summary-cache'

// Session transcripts and metadata live inside the agent workspace, which is
// bind-mounted read/write into its container. They are therefore evidence that
// a session exists, but NOT authoritative proof of which agent owns a globally
// keyed session id: an agent can create arbitrary files in its own workspace.
//
// Keep the ownership index one directory above all workspaces so containers
// cannot forge it. `null` is a fail-closed tombstone for a duplicate id found
// during legacy migration; it must never be claimed implicitly by either agent.
const sessionOwnershipMapSchema = z.record(z.string(), z.string().nullable())
type SessionOwnershipMap = z.infer<typeof sessionOwnershipMapSchema>
const sessionOwnershipByPath = new Map<string, Promise<SessionOwnershipMap>>()

function getSessionOwnershipPath(): string {
  return path.join(path.dirname(getAgentsDir()), 'session-ownership.json')
}

async function candidateSessionIdsForAgent(agentSlug: string): Promise<Set<string>> {
  const ids = new Set(Object.keys(await readSessionMetadata(agentSlug)))
  const sessionsDir = getAgentSessionsDir(agentSlug)
  try {
    const files = await fs.promises.readdir(sessionsDir)
    for (const file of files) {
      if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return new Set([...ids].filter((sessionId) => {
    try {
      getSessionJsonlPath(agentSlug, sessionId)
      return true
    } catch {
      return false
    }
  }))
}

async function discoverSessionOwners(): Promise<SessionOwnershipMap> {
  const discovered = Object.create(null) as SessionOwnershipMap
  for (const agentSlug of await listDirectories(getAgentsDir())) {
    const ids = await candidateSessionIdsForAgent(agentSlug)
    for (const id of ids) {
      if (!Object.hasOwn(discovered, id)) {
        discovered[id] = agentSlug
      } else if (discovered[id] !== agentSlug) {
        discovered[id] = null
      }
    }
  }
  return discovered
}

async function loadSessionOwnershipMap(): Promise<SessionOwnershipMap> {
  const ownershipPath = getSessionOwnershipPath()
  const cached = sessionOwnershipByPath.get(ownershipPath)
  if (cached) return cached

  const loading = withFileLock(ownershipPath, async () => {
    const existed = await fileExists(ownershipPath)
    const stored = await readJsonFileStrict(ownershipPath, sessionOwnershipMapSchema, {})
    if (existed) {
      return Object.assign(Object.create(null) as SessionOwnershipMap, stored)
    }

    const migrated = await discoverSessionOwners()
    await ensureDirectory(path.dirname(ownershipPath))
    await writeJsonFileAtomic(ownershipPath, migrated)
    return migrated
  })
  sessionOwnershipByPath.set(ownershipPath, loading)
  try {
    return await loading
  } catch (error) {
    if (sessionOwnershipByPath.get(ownershipPath) === loading) {
      sessionOwnershipByPath.delete(ownershipPath)
    }
    throw error
  }
}

async function mutateSessionOwnership(
  mutator: (owners: SessionOwnershipMap) => boolean,
): Promise<void> {
  const ownershipPath = getSessionOwnershipPath()
  const owners = await loadSessionOwnershipMap()
  await withFileLock(ownershipPath, async () => {
    const next = Object.assign(Object.create(null) as SessionOwnershipMap, owners)
    if (!mutator(next)) return
    await writeJsonFileAtomic(ownershipPath, next)
    for (const sessionId of Object.keys(owners)) delete owners[sessionId]
    Object.assign(owners, next)
  })
}

async function claimSessionOwnership(agentSlug: string, sessionId: string): Promise<boolean> {
  // Apply the same containment check used by transcript operations before an
  // externally produced id can become a durable registry key.
  getSessionJsonlPath(agentSlug, sessionId)
  let newlyClaimed = false
  await mutateSessionOwnership((owners) => {
    if (!Object.hasOwn(owners, sessionId)) {
      owners[sessionId] = agentSlug
      newlyClaimed = true
      return true
    }
    if (owners[sessionId] !== agentSlug) {
      throw new Error(`Session ${sessionId} is already owned by another agent`)
    }
    return false
  })
  if (newlyClaimed) invalidateSessionSummaryCache(agentSlug)
  return newlyClaimed
}

async function releaseSessionOwnership(agentSlug: string, sessionIds: string[]): Promise<void> {
  const released: string[] = []
  await mutateSessionOwnership((owners) => {
    let changed = false
    for (const sessionId of sessionIds) {
      if (owners[sessionId] === agentSlug) {
        delete owners[sessionId]
        released.push(sessionId)
        changed = true
      }
    }
    return changed
  })
  for (const sessionId of released) removeSessionFromSummaryCache(agentSlug, sessionId)
}

async function resolveSessionOwner(sessionId: string): Promise<string | null | undefined> {
  const owners = await loadSessionOwnershipMap()
  return Object.hasOwn(owners, sessionId) ? owners[sessionId] : undefined
}

/**
 * Reserve a newly allocated session id before exposing it through any
 * process-global lifecycle registry. Registration calls this again
 * idempotently when it persists the display metadata.
 */
export async function reserveSessionOwnership(
  agentSlug: string,
  sessionId: string,
): Promise<void> {
  await claimSessionOwnership(agentSlug, sessionId)
}

/**
 * Authoritative ownership check for registries keyed by session id alone.
 * Unlike transcript/metadata existence, this cannot be forged from inside an
 * agent container because the ownership file is outside its mounted workspace.
 */
export async function sessionBelongsToAgent(
  agentSlug: string,
  sessionId: string,
): Promise<boolean> {
  // Validate the externally supplied id before considering a registry entry.
  try {
    getSessionJsonlPath(agentSlug, sessionId)
  } catch {
    return false
  }
  return (await resolveSessionOwner(sessionId)) === agentSlug
}

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

export type AutomationStatusResult = 'updated' | 'not-automation' | 'already-final'

/**
 * Record the terminal outcome of a cron/webhook session's automation turn.
 *
 * Guard rules live inside the serialized mutator (single locked
 * read-then-maybe-write, no TOCTOU):
 * - non-automation sessions are untouched — callers can cache the
 *   'not-automation' result and skip future calls for that session;
 * - promoted sessions that never tracked an outcome predate automation
 *   status — a later interactive turn's result is not the automation's;
 * - a finalized outcome (anything but 'running') is never overwritten.
 */
export async function finalizeAutomationStatus(
  agentSlug: string,
  sessionId: string,
  automationStatus: 'succeeded' | 'failed'
): Promise<AutomationStatusResult> {
  let result: AutomationStatusResult = 'not-automation'
  await mutateSessionMetadata(agentSlug, (metadata) => {
    const meta = metadata[sessionId]
    if (!meta?.isScheduledExecution && !meta?.isWebhookExecution) return false
    if (meta.promotedToInteractive && !meta.automationStatus) return false
    if (meta.automationStatus && meta.automationStatus !== 'running') {
      result = 'already-final'
      return false
    }
    metadata[sessionId] = { ...meta, automationStatus }
    result = 'updated'
  })
  return result
}

/**
 * Get metadata for a single session
 */
export async function getSessionMetadata(
  agentSlug: string,
  sessionId: string
): Promise<SessionMetadata | null> {
  const metadata = await readSessionMetadata(agentSlug)
  // Own-property check for the same reason as isSessionRegistered: a bare index
  // read returns an inherited Object.prototype member for ids like 'constructor'.
  return Object.hasOwn(metadata, sessionId) ? metadata[sessionId] : null
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
  const newlyClaimed = await claimSessionOwnership(agentSlug, sessionId)
  try {
    await mutateSessionMetadata(agentSlug, (metadata) => {
      metadata[sessionId] = {
        ...initialMetadata,
        name: name || 'New Session',
        createdAt: new Date().toISOString(),
      }
    })
  } catch (error) {
    if (newlyClaimed) await releaseSessionOwnership(agentSlug, [sessionId]).catch(() => {})
    throw error
  }
}

/**
 * Check if a session is registered (exists in metadata)
 *
 * `Object.hasOwn`, not `in` / a bare index read: the metadata map is an ordinary
 * object, so every `Object.prototype` name ('constructor', 'toString', …) would
 * otherwise answer "registered" and walk straight through any gate built on this.
 */
export async function isSessionRegistered(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  const metadata = await readSessionMetadata(agentSlug)
  return Object.hasOwn(metadata, sessionId)
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
 * The four things a SessionInfo needs from a transcript. Accumulated in one
 * streaming pass so a session's size never has to be held in memory: transcripts
 * routinely reach 100MB+ and this summary is a handful of scalars.
 */
interface TranscriptSummary {
  messageCount: number
  firstTimestamp: string | undefined
  lastTimestamp: string | undefined
  /** Content of the first user message whose content is a plain string. */
  firstUserText: string | undefined
}

const EMPTY_TRANSCRIPT_SUMMARY: TranscriptSummary = {
  messageCount: 0,
  firstTimestamp: undefined,
  lastTimestamp: undefined,
  firstUserText: undefined,
}

/**
 * Stream a session transcript and accumulate only what SessionInfo reports.
 * Nothing per-entry is retained, so cost is one pass and constant memory.
 */
async function summarizeSessionTranscript(jsonlPath: string): Promise<TranscriptSummary> {
  const summary: TranscriptSummary = { ...EMPTY_TRANSCRIPT_SUMMARY }

  for await (const raw of streamJsonlFile<JsonlEntry>(jsonlPath)) {
    // Normalize queued_command attachments so mid-turn messages count toward
    // naming, messageCount, and activity timestamps like any other user message.
    const entry = normalizeQueuedCommandEntry(raw)
    if (!isMessageEntry(entry)) continue

    summary.messageCount++
    if (summary.messageCount === 1) summary.firstTimestamp = entry.timestamp
    summary.lastTimestamp = entry.timestamp
    if (
      summary.firstUserText === undefined &&
      entry.type === 'user' &&
      typeof entry.message.content === 'string'
    ) {
      summary.firstUserText = entry.message.content
    }
  }

  return summary
}

/**
 * Project a transcript summary into the session's SessionInfo.
 */
function parseSessionInfo(
  sessionId: string,
  agentSlug: string,
  summary: TranscriptSummary,
  metadata?: SessionMetadata
): SessionInfo {
  // Get timestamps
  let createdAt = new Date()
  let lastActivityAt = new Date()

  if (summary.messageCount > 0) {
    createdAt = new Date(summary.firstTimestamp as string)
    lastActivityAt = new Date(summary.lastTimestamp as string)
  }

  // Generate name from first user message if no custom name
  let name = metadata?.name || 'New Session'
  if (!metadata?.name && summary.firstUserText !== undefined) {
    // Use first 50 chars of first message as name
    const content = summary.firstUserText
    name = content.substring(0, 50).trim()
    if (content.length > 50) {
      name += '...'
    }
  }

  return {
    id: sessionId,
    agentSlug,
    name,
    createdAt,
    lastActivityAt,
    messageCount: summary.messageCount,
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

// Prefer metadata createdAt; birthtime is unsupported (epoch 0) on
// network filesystems like S3 Files / EFS used by the k8s / microVM runtime.
function resolveSessionCreatedAt(
  meta: SessionMetadata | undefined,
  stat: { birthtimeMs: number; birthtime: Date; mtimeMs: number },
): Date {
  if (meta?.createdAt) return new Date(meta.createdAt)
  if (stat.birthtimeMs > 0) return stat.birthtime
  return new Date(stat.mtimeMs)
}

// ============================================================================
// Session Operations
// ============================================================================

function summaryFromActivityMap(activityBySession: Map<string, number>): {
  sessionIds: string[]
  sessionCount: number
  lastActivityAt: Date | null
} {
  const sessionIds = [...activityBySession.keys()]
  let latestMs: number | null = null
  for (const activityAtMs of activityBySession.values()) {
    if (latestMs === null || activityAtMs > latestMs) latestMs = activityAtMs
  }
  return {
    sessionIds,
    sessionCount: sessionIds.length,
    lastActivityAt: latestMs === null ? null : new Date(latestMs),
  }
}

async function getSessionsDirectoryMtime(sessionsDir: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(sessionsDir)
    return stat.isDirectory() ? stat.mtimeMs : null
  } catch {
    // Preserve directoryExists()'s existing fail-soft behavior.
    return null
  }
}

async function buildSessionActivityMap(
  agentSlug: string,
  sessionsDir: string,
  directoryMtimeMs: number | null,
): Promise<Map<string, number>> {
  if (directoryMtimeMs === null) return new Map()

  const files = await fs.promises.readdir(sessionsDir)
  const jsonlFiles = files.filter((file) => file.endsWith('.jsonl'))
  const limit = pLimit(10)
  const stats = await Promise.all(
    jsonlFiles.map((file) => limit(async () => {
      // A transcript deleted between readdir and stat (deleteSession racing a
      // scan) just drops out of this build instead of failing the whole scan.
      const stat = await fs.promises.stat(path.join(sessionsDir, file)).catch(() => null)
      if (!stat) return null
      const sessionId = path.basename(file, '.jsonl')
      if (!(await sessionBelongsToAgent(agentSlug, sessionId))) return null
      return { sessionId, mtimeMs: stat.mtimeMs }
    })),
  )

  const activityBySession = new Map<string, number>()
  for (const entry of stats) {
    if (entry) activityBySession.set(entry.sessionId, entry.mtimeMs)
  }
  return activityBySession
}

/**
 * Lightweight session summary from filesystem stats only (no JSONL parsing).
 * Returns session IDs, count, and latest activity time. The first read (and
 * structural/TTL reconciliation) stats every transcript; warm reads validate
 * the directory with one stat and use stream-maintained per-session mtimes.
 */
export async function getSessionSummary(agentSlug: string): Promise<{
  sessionIds: string[]
  sessionCount: number
  lastActivityAt: Date | null
}> {
  const sessionsDir = getAgentSessionsDir(agentSlug)
  const slot = getSessionSummaryCacheSlot(sessionsDir)
  const directoryMtimeMs = await getSessionsDirectoryMtime(sessionsDir)
  const now = Date.now()
  if (
    slot.value &&
    slot.value.directoryMtimeMs === directoryMtimeMs &&
    now - slot.value.builtAtMs < SESSION_SUMMARY_CACHE_TTL_MS
  ) {
    return summaryFromActivityMap(slot.value.activityBySession)
  }

  if (slot.loading) {
    const loaded = await slot.loading
    if (
      slot.value === loaded &&
      loaded.directoryMtimeMs === directoryMtimeMs &&
      Date.now() - loaded.builtAtMs < SESSION_SUMMARY_CACHE_TTL_MS
    ) {
      return summaryFromActivityMap(loaded.activityBySession)
    }
    return getSessionSummary(agentSlug)
  }

  const revision = slot.revision
  const loading = buildSessionActivityMap(agentSlug, sessionsDir, directoryMtimeMs)
    .then((activityBySession): SessionSummaryCacheValue => {
      if (slot.revision !== revision) {
        if (slot.loading === loading) slot.loading = undefined
        return { directoryMtimeMs, builtAtMs: Date.now(), revision, activityBySession }
      }
      for (const [sessionId, mutation] of slot.pending) {
        if (mutation.deleted) {
          activityBySession.delete(sessionId)
        } else if (mutation.activityAtMs !== undefined && activityBySession.has(sessionId)) {
          activityBySession.set(
            sessionId,
            Math.max(activityBySession.get(sessionId)!, mutation.activityAtMs),
          )
        }
      }
      slot.pending.clear()
      const value = { directoryMtimeMs, builtAtMs: Date.now(), revision, activityBySession }
      slot.value = value
      // Clear the in-flight marker before awaiters resume. Any subsequent
      // mutation can update the completed value directly and need not linger
      // in the pending map until the next TTL rebuild.
      if (slot.loading === loading) slot.loading = undefined
      return value
    })
  slot.loading = loading
  try {
    const loaded = await loading
    if (slot.value !== loaded) return getSessionSummary(agentSlug)
    return summaryFromActivityMap(loaded.activityBySession)
  } finally {
    if (slot.loading === loading) slot.loading = undefined
  }
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

  const isAutomated = (sessionId: string) => isHiddenAutomatedSession(metadata[sessionId])

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

      if (!(await sessionBelongsToAgent(agentSlug, sessionId))) continue

      // Skip empty JSONL files that aren't registered in metadata
      // These are typically created by Claude SDK for subagent directories
      if (stat.size === 0 && !metadata[sessionId]) {
        continue
      }

      // Skip scheduled/webhook sessions when requested
      if (options?.excludeAutomated && isAutomated(sessionId)) {
        continue
      }

      sessions.push({
        id: sessionId,
        agentSlug,
        name: metadata[sessionId]?.name || 'New Session',
        createdAt: resolveSessionCreatedAt(metadata[sessionId], stat),
        lastActivityAt: new Date(stat.mtimeMs),
        messageCount: 0,
      })
    }
  }

  // Then, add sessions from metadata that don't have JSONL files yet
  // (newly created sessions where the agent hasn't streamed yet)
  for (const [sessionId, sessionMeta] of Object.entries(metadata)) {
    if (!processedSessionIds.has(sessionId) && sessionMeta.createdAt) {
      if (!(await sessionBelongsToAgent(agentSlug, sessionId))) continue
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
 * Build SessionInfo for a specific set of session ids without enumerating
 * the sessions directory — one metadata read plus one stat per requested id.
 * The badge/toolbar consumers ("notable sessions") only ever need a handful
 * of live/unread ids; listSessions stats EVERY transcript, which is 20k
 * stats for a 20k-session agent. Unknown ids (no transcript, no metadata
 * registration) are skipped.
 */
export async function listSessionsByIds(
  agentSlug: string,
  sessionIds: string[],
  options?: { excludeAutomated?: boolean },
): Promise<SessionInfo[]> {
  if (sessionIds.length === 0) return []
  const metadata = await readSessionMetadata(agentSlug)
  const isAutomated = (sessionId: string) => isHiddenAutomatedSession(metadata[sessionId])
  const limit = pLimit(10)
  const sessions = await Promise.all(
    [...new Set(sessionIds)].map((sessionId) =>
      limit(async (): Promise<SessionInfo | null> => {
        if (!(await sessionBelongsToAgent(agentSlug, sessionId))) return null
        if (options?.excludeAutomated && isAutomated(sessionId)) return null
        const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
        try {
          const stat = await fs.promises.stat(jsonlPath)
          // Same rule as listSessions: unregistered empty JSONLs are SDK
          // subagent artifacts, not sessions.
          if (stat.size === 0 && !metadata[sessionId]) return null
          return {
            id: sessionId,
            agentSlug,
            name: metadata[sessionId]?.name || 'New Session',
            createdAt: resolveSessionCreatedAt(metadata[sessionId], stat),
            lastActivityAt: new Date(stat.mtimeMs),
            messageCount: 0,
          }
        } catch {
          const meta = metadata[sessionId]
          if (meta?.createdAt) return emptySessionFromMetadata(sessionId, agentSlug, meta)
          return null
        }
      }),
    ),
  )
  return sessions.filter((s): s is SessionInfo => s !== null)
}

/**
 * Get a single session's info
 */
export async function getSession(
  agentSlug: string,
  sessionId: string
): Promise<SessionInfo | null> {
  if (!(await sessionBelongsToAgent(agentSlug, sessionId))) return null
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  const metadata = await getSessionMetadata(agentSlug, sessionId)

  if (await fileExists(jsonlPath)) {
    const summary = await summarizeSessionTranscript(jsonlPath)
    return parseSessionInfo(sessionId, agentSlug, summary, metadata || undefined)
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
    return subtype === 'compact_boundary' || subtype === 'memory_recall' || subtype === 'informational'
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

export interface SessionMessagesPage {
  messages: TransformedItem[]
  nextCursor: string | null
}

const INITIAL_TAIL_FACTOR = 4
// Hard bound on how deep paging can reach: every cursor request re-scans from
// EOF, so history beyond this many raw JSONL lines is unreachable (walk is
// O(depth²)). Lifting it needs an offset-carrying cursor that seeks instead.
const MAX_TAIL_LINES = 50_000

function dropPartialHead<T>(items: T[], reachedStart: boolean): T[] {
  if (reachedStart || items.length === 0) return items
  return items.slice(1)
}

function pageCursor(messages: TransformedItem[], hasOlder: boolean): string | null {
  return hasOlder && messages[0] ? messages[0].id : null
}

/** Tail-window read + parse + transform shared by the page and delta readers.
 *
 * `signal` aborts the read/parse work mid-flight (throws AbortError): the
 * callers are HTTP routes whose clients cancel superseded refetches, and without
 * the signal every abandoned request still pays full transcript reads server-side. */
async function readTransformedTail(
  jsonlPath: string,
  maxLines: number,
  signal?: AbortSignal
): Promise<{
  transformed: TransformedItem[]
  entries: (JsonlMessageEntry | JsonlSystemEntry)[]
  reachedStart: boolean
}> {
  const { lines, reachedStart } = await readJsonlTailLines(jsonlPath, maxLines, signal)
  // An abort landing on the last chunk read still saves the parse/transform
  // below — on large transcripts that is seconds of synchronous work.
  signal?.throwIfAborted()
  const entries: (JsonlMessageEntry | JsonlSystemEntry)[] = []
  for (const line of lines) {
    const parsed = parseJsonlLine<JsonlEntry>(line)
    if (!parsed) continue
    const normalized = normalizeQueuedCommandEntry(parsed)
    if (
      isMessageOrSystemDisplayEntry(normalized) &&
      !('isMeta' in normalized && normalized.isMeta)
    ) {
      entries.push(normalized)
    }
  }
  return { transformed: transformMessages(entries), entries, reachedStart }
}

/** tool_use ids of tool_result blocks recorded after the anchor entry — new
 * lines the client hasn't seen, whose parent assistant items (possibly before
 * the anchor) they mutate. */
function toolResultIdsAfterEntry(
  entries: (JsonlMessageEntry | JsonlSystemEntry)[],
  anchorUuid: string
): Set<string> {
  const ids = new Set<string>()
  const anchorIdx = entries.findIndex((e) => e.uuid === anchorUuid)
  for (let i = anchorIdx + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type !== 'user') continue
    const content = (entry as JsonlMessageEntry).message.content
    if (!Array.isArray(content)) continue
    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_result') ids.add(block.tool_use_id)
    }
  }
  return ids
}

/** Trailing (or `cursor`-before) display page. Parses only a tail of the JSONL. */
export async function getSessionMessagesPage(
  agentSlug: string,
  sessionId: string,
  opts: { limit: number; cursor?: string; signal?: AbortSignal }
): Promise<SessionMessagesPage> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  if (!(await fileExists(jsonlPath))) {
    return { messages: [], nextCursor: null }
  }

  const { limit, cursor, signal } = opts
  let maxLines = Math.min(MAX_TAIL_LINES, Math.max(limit * INITIAL_TAIL_FACTOR, 32))

  for (let attempt = 0; attempt < 32; attempt++) {
    const { transformed, reachedStart } = await readTransformedTail(jsonlPath, maxLines, signal)

    if (cursor) {
      const idx = transformed.findIndex((item) => item.id === cursor)
      if (idx === -1) {
        // Deep cursors from sequential scroll-up paging are legitimate — keep growing.
        if (!reachedStart && maxLines < MAX_TAIL_LINES) {
          maxLines = Math.min(MAX_TAIL_LINES, maxLines * 2)
          continue
        }
        // Vanished id (or cursor deeper than MAX_TAIL_LINES): terminate paging.
        // Never point the client at a newer message — it would loop on
        // already-loaded pages.
        if (!reachedStart) {
          console.warn(
            `getSessionMessagesPage: cursor ${cursor} not found within ` +
            `${MAX_TAIL_LINES} tail lines of session ${sessionId}; ending pagination`
          )
        }
        return { messages: [], nextCursor: null }
      }
      if (!reachedStart && idx <= limit && maxLines < MAX_TAIL_LINES) {
        maxLines = Math.min(MAX_TAIL_LINES, maxLines * 2)
        continue
      }
      const start = reachedStart ? Math.max(0, idx - limit) : Math.max(1, idx - limit)
      const messages = transformed.slice(start, idx)
      const hasOlder = messages.length > 0 && (!reachedStart || start > 0)
      // Sequential walks end here when the cap truncates the page to empty.
      if (messages.length === 0 && !reachedStart) {
        console.warn(
          `getSessionMessagesPage: pagination for session ${sessionId} hit the ` +
          `${MAX_TAIL_LINES}-line depth cap; deeper history is unreachable`
        )
      }
      return { messages, nextCursor: pageCursor(messages, hasOlder) }
    }

    if (!reachedStart && transformed.length <= limit && maxLines < MAX_TAIL_LINES) {
      maxLines = Math.min(MAX_TAIL_LINES, maxLines * 2)
      continue
    }
    const usable = dropPartialHead(transformed, reachedStart)
    const messages = usable.slice(-limit)
    const hasOlder = messages.length > 0 && (!reachedStart || usable.length > messages.length)
    return { messages, nextCursor: pageCursor(messages, hasOlder) }
  }

  throw new Error('getSessionMessagesPage exceeded tail growth attempts')
}

export interface SessionMessagesDelta {
  messages: TransformedItem[]
  /** Last settled item in the server's current view — the client's next `after`. */
  anchor: string | null
  /** Anchor not found within a bounded tail (file rewritten by deletion or
   * retention cleanup, or the anchor is deeper than a live tail can be):
   * the client must fall back to a full page fetch. */
  resync?: true
}

const DELTA_INITIAL_TAIL_LINES = 128
// The anchor is by definition near EOF (the last settled item of a page the
// client already holds); a miss deeper than this is drift, answered with
// resync rather than an unbounded scan.
const DELTA_MAX_TAIL_LINES = 10_000

/** Forward delta: transformed display items at-or-after the `after` anchor, as
 * upserts (full current versions — new lines can mutate items the client
 * already holds, e.g. a tool_result attaching to an earlier assistant item).
 *
 * The window widens backward past the anchor to the first still-mutable item
 * (open tool call in the live turn, trailing assistant message still merging
 * streamed blocks) so a stale anchor still yields every pending upsert. A
 * tail window that cuts an assistant message mid-merge gives the partial item
 * a different id, so an anchor inside a cut group misses and forces growth —
 * anchors always resolve against complete items. */
export async function getSessionMessagesDelta(
  agentSlug: string,
  sessionId: string,
  opts: { after: string; signal?: AbortSignal }
): Promise<SessionMessagesDelta> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  if (!(await fileExists(jsonlPath))) {
    return { messages: [], anchor: null, resync: true }
  }

  const { after, signal } = opts
  let maxLines = DELTA_INITIAL_TAIL_LINES

  for (let attempt = 0; attempt < 32; attempt++) {
    const { transformed, entries, reachedStart } = await readTransformedTail(
      jsonlPath,
      maxLines,
      signal
    )
    const canGrow = !reachedStart && maxLines < DELTA_MAX_TAIL_LINES

    const idx = transformed.findIndex((item) => item.id === after)
    if (idx === -1) {
      if (canGrow) {
        maxLines = Math.min(DELTA_MAX_TAIL_LINES, maxLines * 2)
        continue
      }
      return { messages: [], anchor: null, resync: true }
    }

    const windowStart = findDeltaWindowStart(transformed)
    let start = Math.min(idx, windowStart)
    // Every tool_result recorded after the anchor must have its parent
    // assistant item in the response: the result may have closed a call the
    // client still holds open (e.g. it anchored past a queued mid-turn user
    // message while the call was pending), and only the parent item's upsert
    // carries the resolution.
    const lateResultIds = toolResultIdsAfterEntry(entries, after)
    if (lateResultIds.size > 0) {
      for (let i = 0; i < start; i++) {
        const item = transformed[i]
        if (item.type === 'assistant' && item.toolCalls.some((tc) => lateResultIds.has(tc.id))) {
          start = i
          break
        }
      }
    }
    // Item 0 of a window that didn't reach the file start may be a partially
    // merged assistant message (its leading block entries cut off) — never
    // serve it; grow until the window has context before the response.
    if (start === 0 && !reachedStart) {
      if (canGrow) {
        maxLines = Math.min(DELTA_MAX_TAIL_LINES, maxLines * 2)
        continue
      }
      return { messages: [], anchor: null, resync: true }
    }

    return {
      messages: transformed.slice(start),
      anchor: windowStart > 0 ? transformed[windowStart - 1].id : null,
    }
  }

  throw new Error('getSessionMessagesDelta exceeded tail growth attempts')
}

// Tail-window sizing for findLastSessionEntry: start small (covers the last
// few turns of a typical transcript), escalate when the window has no match,
// and cap before falling back to a full parse.
const TAIL_WINDOW_INITIAL_BYTES = 256 * 1024
const TAIL_WINDOW_GROWTH_FACTOR = 4
const TAIL_WINDOW_MAX_BYTES = 4 * 1024 * 1024

/**
 * Read the last `windowBytes` of a session transcript and return the entries
 * parsed from the complete lines inside that window (same normalization and
 * filtering as getSessionMessagesWithCompact). Returns null when the file does
 * not exist.
 *
 * When the window starts mid-file, everything up to and including the first
 * newline is discarded: that prefix is (almost always) the tail of a line
 * whose start lies outside the window. If the window happens to start exactly
 * on a line boundary this discards one complete line — harmless, because
 * callers never conclude "absent" from a partial window (see
 * findLastSessionEntry). Discarding to a newline also guarantees the decoded
 * text never starts inside a multi-byte UTF-8 sequence.
 */
async function readSessionEntriesFromTail(
  jsonlPath: string,
  windowBytes: number
): Promise<{
  entries: (JsonlMessageEntry | JsonlSystemEntry)[]
  coveredWholeFile: boolean
} | null> {
  let fileHandle: fs.promises.FileHandle
  try {
    fileHandle = await fs.promises.open(jsonlPath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const { size } = await fileHandle.stat()
    const offset = Math.max(0, size - windowBytes)
    const length = size - offset
    const buffer = Buffer.alloc(length)
    let bytesReadTotal = 0
    while (bytesReadTotal < length) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        bytesReadTotal,
        length - bytesReadTotal,
        offset + bytesReadTotal
      )
      if (bytesRead === 0) break // file shrank under us; parse what we got
      bytesReadTotal += bytesRead
    }
    let window = buffer.subarray(0, bytesReadTotal)
    if (offset > 0) {
      const firstNewline = window.indexOf(0x0a) // '\n'
      if (firstNewline === -1) {
        // One line larger than the whole window — no complete line to parse.
        return { entries: [], coveredWholeFile: false }
      }
      window = window.subarray(firstNewline + 1)
    }
    const entries = parseJsonl<JsonlEntry>(window.toString('utf-8'))
      .map(normalizeQueuedCommandEntry)
      .filter(isMessageOrSystemDisplayEntry)
    return { entries, coveredWholeFile: offset === 0 }
  } finally {
    await fileHandle.close()
  }
}

/**
 * Find the newest transcript entry matching `predicate`, over the same entry
 * set getSessionMessagesWithCompact produces, without parsing the whole file.
 * Transcripts routinely reach 100MB+, so callers that only need the most
 * recent entry (e.g. the reply of a just-finished turn) should not pay a full
 * parse — especially inside retry loops.
 *
 * Equivalence with the full parse: every transcript entry is line-local (one
 * JSONL line maps to at most one entry; normalization and filtering never
 * merge or reorder lines, and compact boundaries are ordinary standalone
 * lines), so the newest matching entry within a complete-line tail window is
 * exactly the entry a full parse would select. A window with no match is only
 * trusted when it covered the whole file; otherwise the window escalates and
 * finally falls back to one full parse, so the result always equals the
 * full-parse result — it is just cheaper in the common case.
 */
export async function findLastSessionEntry(
  agentSlug: string,
  sessionId: string,
  predicate: (entry: JsonlMessageEntry | JsonlSystemEntry) => boolean
): Promise<JsonlMessageEntry | JsonlSystemEntry | null> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)

  for (
    let windowBytes = TAIL_WINDOW_INITIAL_BYTES;
    windowBytes <= TAIL_WINDOW_MAX_BYTES;
    windowBytes *= TAIL_WINDOW_GROWTH_FACTOR
  ) {
    const tail = await readSessionEntriesFromTail(jsonlPath, windowBytes)
    if (tail === null) return null // no transcript file
    for (let i = tail.entries.length - 1; i >= 0; i--) {
      if (predicate(tail.entries[i])) return tail.entries[i]
    }
    if (tail.coveredWholeFile) return null
  }

  // The match (if any) starts earlier than the capped window: parse the whole
  // file once so behavior is never worse than the pre-tail-read path.
  const entries = await getSessionMessagesWithCompact(agentSlug, sessionId)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (predicate(entries[i])) return entries[i]
  }
  return null
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
    hadMetadata = Object.hasOwn(metadata, sessionId)
    if (!hadMetadata) return false // nothing to delete — skip the write
    delete metadata[sessionId]
    return true
  })

  const deleted = jsonlExisted || hadMetadata
  if (deleted) await releaseSessionOwnership(agentSlug, [sessionId])
  return deleted
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
        if (Object.hasOwn(metadata, sessionId)) {
          delete metadata[sessionId]
          changed = true
        }
      }
      return changed
    })
    await releaseSessionOwnership(agentSlug, deleted)
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

/**
 * Whether `sessionId` names a session OF THIS AGENT — a written transcript, or a
 * registration for one whose agent hasn't streamed its first message yet. This
 * is exactly the rule getSession returns non-null on, but it costs a stat and a
 * metadata read instead of a full transcript pass. Use it for 404 guards that
 * don't go on to read any SessionInfo field.
 *
 * Both halves are needed: the transcript lands only once the first turn writes,
 * and the metadata entry covers the window from `registerSession` up to then.
 *
 * It is also the ownership gate for every route that reaches a registry keyed by
 * session id ALONE — above all the message persister, which is process-global
 * and has no agent dimension. Authorizing the agent in the URL says nothing
 * about the session id in it, so without this a caller with a role on their own
 * agent drives a stranger's live session.
 *
 * Never throws. `getSessionJsonlPath` rejects ids that escape the agent's
 * session directory, and an id that cannot even name a file under this agent
 * cannot be one of its sessions. Letting that throw escape would hand the
 * request to the caller's `catch`, and interrupt's deliberately marks the
 * session interrupted on the error path — the exact thing the gate exists to
 * stop.
 */
export async function sessionIsKnown(
  agentSlug: string,
  sessionId: string
): Promise<boolean> {
  if (!(await sessionBelongsToAgent(agentSlug, sessionId))) return false
  try {
    if (await sessionExists(agentSlug, sessionId)) return true
    const metadata = await getSessionMetadata(agentSlug, sessionId)
    return Boolean(metadata?.createdAt)
  } catch {
    return false
  }
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

  // Find the target entry by id. Regular messages match by top-level uuid;
  // queued (mid-turn) messages surface in the UI with id = the queued_command
  // attachment's source_uuid (see normalizeQueuedCommandEntry), so match the
  // underlying attachment entry as well.
  const matchesTargetId = (e: JsonlEntry): boolean =>
    ('uuid' in e && e.uuid === messageUuid) ||
    (e.type === 'attachment' && (e as JsonlAttachmentEntry).attachment?.source_uuid === messageUuid)

  // Transcripts run to tens (sometimes hundreds) of MB, so never materialize
  // the whole file: stream once to find the target, once more to collect the
  // associated tool_use ids if needed, then stream-rewrite.
  let target: JsonlEntry | undefined
  try {
    for await (const entry of streamJsonlFile<JsonlEntry>(jsonlPath)) {
      if (matchesTargetId(entry)) {
        target = entry
        break
      }
    }
  } catch (error) {
    // Transcript deleted between the existence check and the read: the old
    // full-read implementation treated this as "not found".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!target) return false

  // Collect message IDs and tool_use IDs to remove
  const messageIdsToRemove = new Set<string>()
  const toolUseIdsToRemove = new Set<string>()

  if (target.type === 'assistant' && target.message.id) {
    // Remove all entries for this assistant message (they share message.id)
    messageIdsToRemove.add(target.message.id)

    // Collect tool_use IDs from all entries with this message.id
    for await (const entry of streamJsonlFile<JsonlEntry>(jsonlPath)) {
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

  await rewriteTranscript(jsonlPath, (entry) => {
    // Remove the target entry (user message or queued_command attachment)
    if (matchesTargetId(entry)) return 'drop'
    if (!('uuid' in entry)) return 'keep' // keep non-message entries
    const e = entry as JsonlMessageEntry
    if (e.type === 'assistant' && e.message.id && messageIdsToRemove.has(e.message.id)) return 'drop'

    // Remove tool_result user entries referencing removed tool calls
    if (e.type === 'user' && toolUseIdsToRemove.size > 0) {
      const content = e.message.content
      if (Array.isArray(content)) {
        const blocks = content as ContentBlock[]
        if (blocks.every((b) => b.type === 'tool_result' && toolUseIdsToRemove.has(b.tool_use_id))) {
          return 'drop'
        }
      }
    }

    return 'keep'
  })
  recordSessionActivity(agentSlug, sessionId)
  return true
}

/**
 * Stream-rewrite a transcript, deciding per entry whether to keep, drop, or
 * replace its line. Kept lines are copied through byte-for-byte from the
 * original file (never parse-and-restringified, which could alter number
 * formatting or unicode escapes); blank/malformed lines are copied through
 * untouched. Output goes to a sibling temp file that atomically replaces the
 * original (see writeFileAtomicStream), so a failure mid-rewrite leaves the
 * transcript exactly as it was.
 *
 * Like the read-modify-write it replaces, this takes no lock against
 * concurrent transcript appends — callers rely on the same exclusivity
 * assumption as before.
 */
async function rewriteTranscript(
  jsonlPath: string,
  mapEntry: (entry: JsonlEntry) => JsonlEntry | 'keep' | 'drop'
): Promise<void> {
  const newline = Buffer.from('\n')
  async function* lines(): AsyncGenerator<Buffer | string> {
    for await (const raw of streamFileLines(jsonlPath)) {
      const entry = parseJsonlLine<JsonlEntry>(raw)
      if (entry === undefined) {
        // Blank or malformed line (mid-write artifact): copy through untouched
        yield raw
        yield newline
        continue
      }
      const result = mapEntry(entry)
      if (result === 'drop') continue
      if (result === 'keep') {
        yield raw
        yield newline
        continue
      }
      yield JSON.stringify(result) + '\n'
    }
  }
  await writeFileAtomicStream(jsonlPath, lines())
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

  // Decide what to do with one entry: remove the tool_use block from assistant
  // entries and the tool_result block from user entries, dropping an entry
  // whose content would become empty. Untouched entries are kept verbatim.
  const mapEntry = (entry: JsonlEntry): JsonlEntry | 'keep' | 'drop' => {
    if (!('message' in entry)) return 'keep'
    const e = entry as JsonlMessageEntry

    // Remove tool_result user entries for this tool call
    if (e.type === 'user' && Array.isArray(e.message.content)) {
      const blocks = e.message.content as ContentBlock[]
      const remaining = blocks.filter(
        (b) => !(b.type === 'tool_result' && b.tool_use_id === toolCallId)
      )
      if (remaining.length < blocks.length) {
        if (remaining.length === 0) return 'drop' // drop entire entry
        return { ...e, message: { ...e.message, content: remaining } }
      }
    }

    // Remove tool_use block from assistant entries
    if (e.type === 'assistant' && Array.isArray(e.message.content)) {
      const blocks = e.message.content as ContentBlock[]
      const remaining = blocks.filter(
        (b) => !(b.type === 'tool_use' && b.id === toolCallId)
      )
      if (remaining.length < blocks.length) {
        if (remaining.length === 0) return 'drop' // drop entire entry
        return { ...e, message: { ...e.message, content: remaining } }
      }
    }

    return 'keep'
  }

  // First streaming pass: bail out (and leave the file untouched) unless some
  // entry actually references this tool call — matches the old behavior of
  // only writing when `found`.
  let found = false
  try {
    for await (const entry of streamJsonlFile<JsonlEntry>(jsonlPath)) {
      if (mapEntry(entry) !== 'keep') {
        found = true
        break
      }
    }
  } catch (error) {
    // Transcript deleted between the existence check and the read: the old
    // full-read implementation treated this as "not found".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!found) return false

  await rewriteTranscript(jsonlPath, mapEntry)
  recordSessionActivity(agentSlug, sessionId)
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
    const meta = metadata[sessionId]
    try {
      const stat = await fs.promises.stat(jsonlPath)
      sessions.push({
        id: sessionId,
        agentSlug,
        name: meta?.name || 'New Session',
        createdAt: resolveSessionCreatedAt(meta, stat),
        lastActivityAt: new Date(stat.mtimeMs),
        messageCount: 0,
      })
    } catch {
      // JSONL doesn't exist yet — use metadata createdAt
      if (meta) {
        sessions.push(emptySessionFromMetadata(sessionId, agentSlug, meta))
      }
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
