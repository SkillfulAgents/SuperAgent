import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { findLastSessionEntry } from '@shared/lib/services/session-service'
import { compactMessage } from './x-agent-transcript-view'

/**
 * After a sync invoke, the SDK may emit 'result' (which clears isActive) before
 * the assistant message has been flushed to the JSONL file. Poll briefly so
 * we return the actual response, not the user prompt.
 *
 * Total wait: ~5s (10 × 500ms). Generous enough to absorb slow filesystems
 * (NFS, encrypted home, AV scanners) without keeping the HTTP handler open
 * indefinitely. Polling stops as soon as an assistant entry is found.
 *
 * Returns the compacted last assistant message, or null if no assistant entry
 * appears within the retry window. compactMessage always returns non-empty
 * content for assistant entries (placeholders for thinking-only / empty turns),
 * so a null return here specifically means "no assistant turn was persisted".
 */
// Tests can shrink the retry budget via env to keep timeouts snappy.
const READ_RETRY_ATTEMPTS = Number(process.env.X_AGENT_READ_RETRY_ATTEMPTS) || 10
const READ_RETRY_INTERVAL_MS = Number(process.env.X_AGENT_READ_RETRY_INTERVAL_MS) || 500

export function isReturnableAssistantEntry(e: JsonlMessageEntry | JsonlSystemEntry): boolean {
  return e.type === 'assistant' && compactMessage(e) !== null
}

/**
 * `boundaryUuid` is the uuid of the last assistant entry persisted BEFORE the
 * current turn's prompt was delivered (undefined when the session is new or
 * had none). Seeing that entry still last means this turn's reply hasn't
 * flushed yet — keep polling rather than returning the previous turn's answer
 * as if it were this one's.
 */
export async function readLastAssistantMessage(
  targetSlug: string,
  sessionId: string,
  boundaryUuid?: string,
  attempts: number = READ_RETRY_ATTEMPTS,
): Promise<{ role: string; content: string; toolName?: string } | null> {
  for (let i = 0; i < attempts; i++) {
    // Only the most recent assistant entry matters, so read the transcript
    // from the tail instead of full-parsing it (transcripts reach 100MB+, and
    // this runs up to READ_RETRY_ATTEMPTS times per invoke).
    const entry = await findLastSessionEntry(targetSlug, sessionId, isReturnableAssistantEntry)
    const isStaleBoundary = boundaryUuid !== undefined && entry?.uuid === boundaryUuid
    if (entry && !isStaleBoundary) {
      const compact = compactMessage(entry)
      if (compact) {
        return {
          role: compact.role,
          content: compact.content,
          ...(compact.toolName ? { toolName: compact.toolName } : {}),
        }
      }
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, READ_RETRY_INTERVAL_MS))
    }
  }
  return null
}
