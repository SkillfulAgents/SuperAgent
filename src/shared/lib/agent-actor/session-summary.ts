/**
 * The agent's sessions at a glance, from its session index entries. Pure and
 * import-light, so whatever holds the entries can answer it.
 */
import type { SessionMetadataMap } from '@shared/lib/types/agent'
import type { SessionIndexEntry } from './session-index'
import type { SessionSummary } from './types'

/** Sessions with a transcript count; metadata is kept for every entry that has it. */
export function summarizeSessions(entries: readonly SessionIndexEntry[]): SessionSummary {
  const sessionIds: string[] = []
  const metadata: SessionMetadataMap = {}
  let latestMs: number | null = null
  for (const { sessionId, meta, transcript } of entries) {
    if (meta) metadata[sessionId] = meta
    if (!transcript) continue
    sessionIds.push(sessionId)
    if (latestMs === null || transcript.mtimeMs > latestMs) latestMs = transcript.mtimeMs
  }
  return {
    sessionIds,
    sessionCount: sessionIds.length,
    lastActivityAt: latestMs === null ? null : new Date(latestMs),
    metadata,
  }
}
