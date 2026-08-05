import * as fs from 'fs'
import * as path from 'path'
import { getSessionJsonlPath } from '@shared/lib/utils/file-storage'
import type { JsonlSystemEntry } from '@shared/lib/types/agent'

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
  const existing = await fs.promises.readFile(jsonlPath, 'utf-8').catch(() => null)
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
}
