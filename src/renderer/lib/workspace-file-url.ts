import { toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'
import { getApiBaseUrl } from '@renderer/lib/env'

/**
 * Whether a container path is safe to build a workspace-file URL from.
 *
 * The encoder below escapes what it is handed; it cannot sanitise it. `..` and
 * `.` survive `encodeURIComponent` unchanged, so a traversal has to be
 * *rejected* rather than escaped — which makes this the check, and the only
 * one. A path that does not sit under `/workspace` fails it too, since
 * `toWorkspaceRelativePath` leaves the leading slash on anything else and an
 * empty first segment is not a name.
 *
 * Paths handed over by the API or by a tool result are already resolved by the
 * server. This is for the ones that are not: an `<img src>` in a Markdown
 * document the agent wrote.
 */
export function isSafeWorkspaceFilePath(filePath: string): boolean {
  if (filePath.includes('\0')) return false
  const relative = toWorkspaceRelativePath(filePath)
  if (!relative) return false
  return relative.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

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
