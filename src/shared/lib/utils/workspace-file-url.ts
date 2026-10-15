import { toWorkspaceRelativePath } from './workspace-path'

/** Convert a container workspace path into safely encoded API path segments. */
export function encodeWorkspaceFilePath(filePath: string): string {
  return toWorkspaceRelativePath(filePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/** The app route that serves a workspace file's bytes. */
export function getAgentFileApiPath(agentSlug: string, filePath: string): string {
  return `/api/agents/${encodeURIComponent(agentSlug)}/files/${encodeWorkspaceFilePath(filePath)}`
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
