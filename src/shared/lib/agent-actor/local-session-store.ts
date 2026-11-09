/**
 * The session store of an agent whose workspace is a directory on this
 * machine: local file operations, local configuration documents, a session
 * index in the app database, and the transcripts directory the CLI uses with
 * the workspace mounted at `/workspace`.
 */
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import { createLocalConfigOps } from './local-config-ops'
import { createDbSessionIndexStorage } from './db-session-index-storage'
import { createLocalFileOps } from './local-file-ops'
import { SessionIndex, type SessionIndexStorage } from './session-index'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from './session-store'
import type { AgentSlug } from './types'

export interface LocalSessionStoreDeps {
  getAgentWorkspaceDir: (slug: string) => string
  /** Where the agent's index entries are stored; the app database unless given. */
  sessionIndexStorage?: (slug: AgentSlug) => SessionIndexStorage
}

// Read at call time: a test that mocks the path helpers is not obliged to
// provide this one until a store is used.
const defaultDeps: LocalSessionStoreDeps = { getAgentWorkspaceDir: (slug) => getAgentWorkspaceDir(slug) }

export function createLocalSessionStore(
  slug: AgentSlug,
  overrides: Partial<LocalSessionStoreDeps> = {},
  hooks: Pick<SessionStore, 'onActivity'> = {},
): SessionStore {
  // Named, not spread: an actor hands its whole dependency object in, whose
  // members are getters that must not all be read just to build a store.
  const deps: LocalSessionStoreDeps = {
    getAgentWorkspaceDir: (agent) => (overrides.getAgentWorkspaceDir ?? defaultDeps.getAgentWorkspaceDir)(agent),
    sessionIndexStorage: overrides.sessionIndexStorage,
  }
  const files = createLocalFileOps(slug, deps)
  const config = createLocalConfigOps({ files, workspaceHostPath: () => deps.getAgentWorkspaceDir(slug) })
  // Read at call time, like the file operations' root: tests and embedded
  // deployments change the data directory in-process, and what was learned
  // from a directory must follow the directory, not the slug.
  const key = () => deps.getAgentWorkspaceDir(slug)
  return {
    slug,
    files,
    config,
    transcriptsDir: CLI_TRANSCRIPTS_DIR,
    index: new SessionIndex({
      files,
      transcriptsDir: CLI_TRANSCRIPTS_DIR,
      key,
      storage: (deps.sessionIndexStorage ?? createDbSessionIndexStorage)(slug),
    }),
    onActivity: hooks.onActivity,
    get key() {
      return key()
    },
  }
}
