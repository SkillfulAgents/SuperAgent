const WORKSPACE_PREFIX = '/workspace/'

/**
 * Chat markdown file links that point at a container workspace path.
 * Only `/workspace/...` counts. Bare filenames, in-app routes, and schemes do not.
 * Decodes once so a CommonMark `%20` becomes a real space before the file API encodes.
 */
export function workspaceFilePathFromHref(href: string | undefined | null): string | null {
  if (!href) return null
  const pathOnly = href.split(/[?#]/)[0] ?? ''
  if (!pathOnly.startsWith(WORKSPACE_PREFIX)) return null
  if (pathOnly.length <= WORKSPACE_PREFIX.length) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    return null
  }
  if (!decoded.startsWith(WORKSPACE_PREFIX)) return null
  if (decoded.length <= WORKSPACE_PREFIX.length) return null
  return decoded
}

/** Convert a container workspace path into safely encoded API path segments. */
export function encodeWorkspaceFilePath(filePath: string): string {
  const relativePath = filePath.replace(/^\/workspace\/?/, '')
  return relativePath
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

export function getAgentFileApiPath(agentSlug: string, filePath: string): string {
  return `/api/agents/${encodeURIComponent(agentSlug)}/files/${encodeWorkspaceFilePath(filePath)}`
}
