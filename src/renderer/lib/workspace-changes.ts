import type { QueryClient } from '@tanstack/react-query'
import { isPathAtOrBelow, toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'

/** `agentSlug` null means every agent; a scope is a file, a folder, or `/workspace` for everything. */
type Listener = (agentSlug: string | null, scopes: string[]) => void

const listeners = new Set<Listener>()

/** Open file views hear the workspace paths that changed. */
export function subscribeWorkspaceChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reload open file tabs and open folder listings at or around the changed scopes. */
export function emitWorkspaceChanges(queryClient: QueryClient, agentSlug: string | null, scopes: string[]): void {
  listeners.forEach(listener => listener(agentSlug, scopes))
  // Folder tabs list through ['folder-entries', agentSlug, rootPath, folderPath].
  void queryClient.invalidateQueries({
    predicate: ({ queryKey: [kind, slug, , folderPath] }) => kind === 'folder-entries'
      && (agentSlug === null || slug === agentSlug)
      && typeof folderPath === 'string' && overlapsChange(folderPath, scopes),
  })
}

/** `''` is the whole workspace, so everything is below it. */
function isAtOrBelow(base: string, candidate: string): boolean {
  return base === '' || isPathAtOrBelow(base, candidate)
}

/** Whether a workspace path sits at or under one of the changed scopes. */
export function isUnderChange(path: string, scopes: string[]): boolean {
  const rel = toWorkspaceRelativePath(path)
  return scopes.some(scope => isAtOrBelow(toWorkspaceRelativePath(scope), rel))
}

/** Whether a folder's listing may have changed: a change at, above, or below it. */
export function overlapsChange(folderPath: string, scopes: string[]): boolean {
  const rel = toWorkspaceRelativePath(folderPath)
  return scopes.some(scope => {
    const changed = toWorkspaceRelativePath(scope)
    return isAtOrBelow(changed, rel) || isAtOrBelow(rel, changed)
  })
}
