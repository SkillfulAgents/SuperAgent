/**
 * A `SessionStore` over an in-memory workspace: for tests that drive the
 * message persister, or the session service, without a directory on disk.
 */
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '../session-store'
import type { AgentSlug } from '../types'
import { createInMemoryConfigOps } from './in-memory-config-ops'
import { InMemoryFileOps } from './in-memory-file-ops'

export function createInMemorySessionStore(slug: AgentSlug): SessionStore & { files: InMemoryFileOps } {
  const files = new InMemoryFileOps()
  return {
    slug,
    files,
    config: createInMemoryConfigOps(files),
    transcriptsDir: CLI_TRANSCRIPTS_DIR,
    key: `memory:${slug}:${Math.random().toString(36).slice(2)}`,
  }
}
