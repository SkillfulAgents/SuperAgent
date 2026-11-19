import { isMountPath, parseMountPath, toWorkspaceRelativePath } from './workspace-path'

/** Escape each segment of a path, keeping its slashes, a leading one included. */
export function encodePathSegments(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** Convert a container workspace path into safely encoded API path segments. */
export function encodeWorkspaceFilePath(filePath: string): string {
  return encodePathSegments(toWorkspaceRelativePath(filePath).split('/').filter(Boolean).join('/'))
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

/**
 * The absolute path a markdown url names as a local file (`/abs` or `file:///abs`), or null.
 * With a `folder`, a relative url resolves from it. A folder keeps its trailing slash.
 * Each segment is decoded once: a stray `%` keeps its raw name, and an escaped `/` names nothing.
 */
export function localFilePath(url: string, folder?: string): string | null {
  // A host is not a local file, and `//localhost` would parse as one. A bare heading or query names no path.
  if (url === '' || url.startsWith('//') || url.startsWith('#') || url.startsWith('?')) return null
  let pathname: string
  try {
    // Without a folder a relative url does not parse, and any other scheme fails the file: check.
    const parsed = new URL(url.startsWith('/') ? `file://${url}` : url, folder === undefined ? undefined : `file://${encodePathSegments(folder)}/`)
    if (parsed.protocol !== 'file:' || parsed.hostname !== '') return null
    pathname = parsed.pathname
  } catch {
    return null
  }
  const segments = pathname.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })
  return segments.some(segment => segment.includes('/')) ? null : segments.join('/')
}
