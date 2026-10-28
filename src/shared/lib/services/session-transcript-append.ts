import { randomUUID } from 'crypto'
import { isAbsentFile } from '@shared/lib/agent-actor/jsonl-files'
import { transcriptPath, type SessionStore } from '@shared/lib/agent-actor/session-store'
import type { JsonlSystemEntry } from '@shared/lib/types/agent'
import { recordSessionActivity } from './session-summary-cache'

/**
 * How far back (in bytes) the duplicate-uuid check scans from the end of the
 * transcript. Duplicates only arise near-in-time — a hook double-delivery or a
 * late-join replay lands within moments of the original append — so a generous
 * tail window preserves the dedup in practice while keeping the check O(window)
 * instead of re-reading a transcript that routinely runs to tens of MB. A
 * duplicate uuid older than the window would be re-appended; that trade is
 * deliberate.
 */
const DEDUP_SCAN_WINDOW_BYTES = 1024 * 1024

/**
 * Read up to the last `maxBytes` bytes of a transcript as UTF-8. Returns null
 * when the file is missing or unreadable. A window boundary can split a
 * multi-byte character, but the scan only searches for an ASCII-quoted uuid,
 * so that never affects the match.
 */
async function readTranscriptTail(store: SessionStore, jsonlPath: string, maxBytes: number): Promise<string | null> {
  try {
    const file = await store.files.open(jsonlPath)
    try {
      const size = await file.size()
      const start = Math.max(0, size - maxBytes)
      return Buffer.from(await file.readAt(start, size - start)).toString('utf-8')
    } finally {
      await file.close()
    }
  } catch (error) {
    if (isAbsentFile(error)) return null
    return null
  }
}

/**
 * Append a host-authored `system`/`informational` entry to a session's JSONL
 * transcript. The CLI writes nothing to the transcript when a UserPromptSubmit
 * hook blocks a prompt — the warning exists only on the live SDK stream — so
 * the host persists it here to make the block visible (and reload-safe) in the
 * transcript. Creates the transcript file (and parent dirs) if the block
 * happened before the CLI ever wrote one.
 *
 * Lives in its own module (not session-service) so the many tests that mock
 * session-service with explicit factories keep working unchanged.
 */
export async function appendInformationalEntry(
  store: SessionStore,
  sessionId: string,
  entry: { uuid: string; content: string; level?: string }
): Promise<void> {
  const jsonlPath = transcriptPath(store, sessionId)
  // Idempotent by uuid: some hook shapes (continue:false) make the CLI persist
  // the banner itself with the streamed uuid, and the container's late-join
  // replay can deliver the same frame twice — never write a duplicate line.
  // Duplicates land near-in-time, so scanning the tail window is sufficient.
  const existing = await readTranscriptTail(store, jsonlPath, DEDUP_SCAN_WINDOW_BYTES)
  if (existing?.includes(`"${entry.uuid}"`)) return
  const jsonlEntry: JsonlSystemEntry = {
    uuid: entry.uuid,
    type: 'system',
    subtype: 'informational',
    content: entry.content,
    level: entry.level,
    isMeta: false,
    timestamp: new Date().toISOString(),
  }
  await store.files.append(jsonlPath, JSON.stringify(jsonlEntry) + '\n')
  recordSessionActivity(store, sessionId)
}

/**
 * Record an assistant message that reached the user out of band (a chat
 * notification the container never produced) so the transcript shows what was
 * said. The caller awaits it: it is answering a webhook and must not lose the
 * line to a dropped promise. Does not record activity; the caller does, since
 * it also has a path that goes through the container.
 */
export async function appendAssistantEntry(store: SessionStore, sessionId: string, text: string): Promise<void> {
  const entry = {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
  }
  await store.files.append(transcriptPath(store, sessionId), JSON.stringify(entry) + '\n')
}
