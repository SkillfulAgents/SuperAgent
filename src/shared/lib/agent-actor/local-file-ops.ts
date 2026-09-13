import type { AgentSlug, FileOps } from './types'

export interface LocalFileOpsDeps {
  getAgentWorkspaceDir: (slug: string) => string
}

/**
 * Workspace file operations for an agent whose files live on this machine.
 * The `/files/*` route bodies move in here when that route is ported.
 */
export function createLocalFileOps(slug: AgentSlug, deps: LocalFileOpsDeps): FileOps {
  return {
    workspacePath: () => deps.getAgentWorkspaceDir(slug),
  }
}
