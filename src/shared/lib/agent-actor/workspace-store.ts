/**
 * Where a deployment keeps its agents' workspaces. With none registered,
 * every workspace is a directory on this machine. A deployment that keeps
 * them elsewhere registers its store at boot, before any agent is created or
 * read: actors open their session store through it, and the catalog records
 * its `runtime` as the placement of the agents it creates.
 */
import type { SessionStore } from './session-store'
import type { AgentSlug } from './types'

export interface WorkspaceStore {
  /** The placement `runtime` of the agents whose workspaces it holds. */
  readonly runtime: string
  open(slug: AgentSlug, hooks: Pick<SessionStore, 'onActivity'>): SessionStore
}

let registered: WorkspaceStore | null = null

/** Null goes back to workspaces on this machine. */
export function registerWorkspaceStore(store: WorkspaceStore | null): void {
  registered = store
}

export function registeredWorkspaceStore(): WorkspaceStore | null {
  return registered
}
