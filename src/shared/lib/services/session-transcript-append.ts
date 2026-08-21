import * as fs from 'fs'
import * as path from 'path'
import { getSessionJsonlPath } from '@shared/lib/utils/file-storage'
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
 * Read up to the last `maxBytes` bytes of a file as UTF-8. Returns null when
 * the file is missing or unreadable (mirrors the readFile().catch(null) it
 * replaces). A window boundary can split a multi-byte character, but the scan
 * only searches for an ASCII-quoted uuid, so that never affects the match.
 */
async function readFileTail(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - maxBytes)
      const length = size - start
      const buf = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await handle.read(buf, offset, length - offset, start + offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return buf.subarray(0, offset).toString('utf-8')
    } finally {
      await handle.close()
    }
  } catch {
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
  agentSlug: string,
  sessionId: string,
  entry: { uuid: string; content: string; level?: string }
): Promise<void> {
  const jsonlPath = getSessionJsonlPath(agentSlug, sessionId)
  // Idempotent by uuid: some hook shapes (continue:false) make the CLI persist
  // the banner itself with the streamed uuid, and the container's late-join
  // replay can deliver the same frame twice — never write a duplicate line.
  // Duplicates land near-in-time, so scanning the tail window is sufficient.
  const existing = await readFileTail(jsonlPath, DEDUP_SCAN_WINDOW_BYTES)
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
  await fs.promises.mkdir(path.dirname(jsonlPath), { recursive: true })
  await fs.promises.appendFile(jsonlPath, JSON.stringify(jsonlEntry) + '\n', 'utf-8')
  recordSessionActivity(agentSlug, sessionId)
}
