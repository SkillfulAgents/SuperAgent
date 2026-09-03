const WORKSPACE_PREFIX = '/workspace/'

function hasDotPathSegment(filePath: string): boolean {
  return filePath.split('/').some(segment => segment === '.' || segment === '..')
}

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
  // URL parsers resolve dot segments before the request reaches the file API.
  // In cloud mode that could remove the keyed proxy prefix and retarget the
  // preview at the loopback API, so reject navigation segments after decoding.
  if (hasDotPathSegment(decoded)) return null
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

export function getAgentFileApiPath(agentSlug: string, filePath: string): string | null {
  // Callers such as delivered files and bookmarks do not pass through
  // workspaceFilePathFromHref, so keep the URL-construction boundary safe too.
  // Do not decode here: a literal "%2e%2e" filename is re-encoded safely.
  if (hasDotPathSegment(filePath)) return null
  return `/api/agents/${encodeURIComponent(agentSlug)}/files/${encodeWorkspaceFilePath(filePath)}`
}
