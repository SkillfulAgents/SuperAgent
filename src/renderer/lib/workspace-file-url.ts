import { toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'
import { getApiBaseUrl } from '@renderer/lib/env'

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

interface AgentFileUrlOptions {
  /** Ask the route to serve the bytes for display rather than as a download. */
  inline?: boolean
  /**
   * The tab's cache-busting token. `v` is not read by the server: it exists so
   * a redelivered file does not resolve to a URL a browser or CDN still holds
   * the previous body for. `0` means "never redelivered" and is left off.
   */
  version?: number
}

/** Absolute URL for a workspace file, for an `<a href>`, an `<img src>` or a fetch. */
export function getAgentFileUrl(
  agentSlug: string,
  filePath: string,
  { inline = false, version = 0 }: AgentFileUrlOptions = {},
): string {
  const params = new URLSearchParams()
  if (inline) params.set('inline', 'true')
  if (version > 0) params.set('v', String(version))
  const query = params.toString()
  return `${getApiBaseUrl()}${getAgentFileApiPath(agentSlug, filePath)}${query ? `?${query}` : ''}`
}
