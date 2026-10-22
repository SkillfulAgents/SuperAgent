/**
 * The session store of an agent whose workspace is a directory on this
 * machine: local file operations, local configuration documents, and the
 * transcripts directory the CLI uses with the workspace mounted at
 * `/workspace`.
 */
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import { SessionSummaryCache } from '@shared/lib/services/session-summary-slot'
import { createLocalConfigOps } from './local-config-ops'
import { createLocalFileOps } from './local-file-ops'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from './session-store'
import type { AgentSlug, StoreConfigOps, StoreFileOps } from './types'

export interface LocalSessionStoreDeps {
  getAgentWorkspaceDir: (slug: string) => string
}

// Read at call time: a test that mocks the path helpers is not obliged to
// provide this one until a store is used.
const defaultDeps: LocalSessionStoreDeps = { getAgentWorkspaceDir: (slug) => getAgentWorkspaceDir(slug) }

/** An agent's files and config documents, for a deployment that doesn't keep workspaces on this machine. */
export type WorkspaceStore = (slug: AgentSlug) => { files: StoreFileOps; config: StoreConfigOps }

let workspaceStore: WorkspaceStore | null = null

/** Replaces the local workspace directory as where every agent's files and config documents live. */
export function setWorkspaceStore(store: WorkspaceStore | null): void {
  workspaceStore = store
}

export function createLocalSessionStore(
  slug: AgentSlug,
  deps: LocalSessionStoreDeps = defaultDeps,
  hooks: Pick<SessionStore, 'onActivity'> = {},
): SessionStore {
  const supplied = workspaceStore?.(slug)
  const files = supplied?.files ?? createLocalFileOps(slug, deps)
  const config = supplied?.config ?? createLocalConfigOps({ files, workspaceHostPath: () => deps.getAgentWorkspaceDir(slug) })
  return {
    slug,
    files,
    config,
    transcriptsDir: CLI_TRANSCRIPTS_DIR,
    summaryCache: new SessionSummaryCache(),
    onActivity: hooks.onActivity,
    // Read at call time, like the file operations' root: tests and embedded
    // deployments change the data directory in-process, and cached state must
    // follow the directory, not the slug.
    get key() {
      return deps.getAgentWorkspaceDir(slug)
    },
  }
}
