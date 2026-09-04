import { toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'

/** Convert a container workspace path into safely encoded API path segments. */
export function encodeWorkspaceFilePath(filePath: string): string {
  return toWorkspaceRelativePath(filePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

export function getAgentFileApiPath(agentSlug: string, filePath: string): string {
  return `/api/agents/${encodeURIComponent(agentSlug)}/files/${encodeWorkspaceFilePath(filePath)}`
}
