/**
 * A `SessionStore` over an in-memory workspace: for tests that drive an
 * agent's live sessions, or the session service, without a directory on disk.
 */
import { SessionIndex } from '../session-index'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '../session-store'
import type { AgentSlug } from '../types'
import { createInMemoryConfigOps } from './in-memory-config-ops'
import { InMemoryFileOps } from './in-memory-file-ops'
import { createInMemorySessionIndexStorage } from './in-memory-session-index-storage'

export function createInMemorySessionStore(slug: AgentSlug): SessionStore & { files: InMemoryFileOps } {
  const files = new InMemoryFileOps()
  const key = `memory:${slug}:${Math.random().toString(36).slice(2)}`
  return {
    slug,
    files,
    config: createInMemoryConfigOps(files),
    transcriptsDir: CLI_TRANSCRIPTS_DIR,
    key,
    index: new SessionIndex({
      files,
      transcriptsDir: CLI_TRANSCRIPTS_DIR,
      key: () => key,
      storage: createInMemorySessionIndexStorage(),
    }),
  }
}
