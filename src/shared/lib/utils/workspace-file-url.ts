import { isMountPath, parseMountPath, toWorkspaceRelativePath } from './workspace-path'

/** Convert a container workspace path into safely encoded API path segments. */
export function encodeWorkspaceFilePath(filePath: string): string {
  return toWorkspaceRelativePath(filePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/** The app route that serves a workspace file's bytes, or a drive file's by the path the agent sees it at. */
export function getAgentFileApiPath(agentSlug: string, filePath: string): string {
  const agent = `/api/agents/${encodeURIComponent(agentSlug)}`
  if (isMountPath(filePath)) {
    // A path the server would refuse goes whole as one escaped segment, so a `..` reaches its check instead of being resolved away by the URL.
    return `${agent}/mount-files/${parseMountPath(filePath) ? encodeWorkspaceFilePath(filePath.slice('/mounts/'.length)) : encodeURIComponent(filePath)}`
  }
  return `${agent}/files/${encodeWorkspaceFilePath(filePath)}`
}

/**
 * An absolute link to a workspace file for people outside the app, such as a
 * meeting chat. `inline` asks the route to serve the file for display, so an
 * image or PDF opens in the browser instead of downloading.
 *
 * The route is read-gated like the rest of the agent API: the link works for
 * whoever may view the agent, which in local mode is anyone who can reach the
 * host. A tokenized file link is still to come for auth mode.
 */
export function publicWorkspaceFileUrl(baseUrl: string, agentSlug: string, filePath: string, { inline = true } = {}): string {
  return `${baseUrl.replace(/\/+$/, '')}${getAgentFileApiPath(agentSlug, filePath)}${inline ? '?inline=true' : ''}`
}
