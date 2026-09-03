const WORKSPACE_PREFIX = '/workspace/'

function hasDotPathSegment(filePath: string): boolean {
  return filePath.split('/').some(segment => segment === '.' || segment === '..')
}

/** POSIX-style `.` / `..` collapse. Matches `path.posix.normalize` for these paths. */
function posixNormalize(input: string): string {
  const absolute = input.startsWith('/')
  const parts: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop()
      } else if (!absolute) {
        parts.push('..')
      }
    } else {
      parts.push(segment)
    }
  }
  const body = parts.join('/')
  if (absolute) return `/${body}`
  return body || '.'
}

function decodeHrefCandidate(pathOnly: string): string | null {
  if (!pathOnly.startsWith(WORKSPACE_PREFIX)) return null
  if (pathOnly.length <= WORKSPACE_PREFIX.length) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    decoded = pathOnly
  }
  // URL parsers resolve dot segments before the request reaches the file API.
  // In cloud mode that could remove the keyed proxy prefix and retarget the
  // preview at the loopback API, so reject navigation segments after decoding.
  if (hasDotPathSegment(decoded)) return null
  return decoded
}

/**
 * Chat markdown file links that point at a container workspace path.
 * Only `/workspace/...` counts. Bare filenames, in-app routes, and schemes do not.
 * Tries the full destination first so a literal `#` or `?` in the name is kept,
 * then falls back to the query/hash-stripped form.
 * Decodes once so a CommonMark `%20` becomes a real space before the file API encodes.
 * A malformed percent-escape keeps the raw name.
 */
export function workspaceFilePathFromHref(href: string | undefined | null): string | null {
  if (!href) return null
  const stripped = href.split(/[?#]/)[0]
  const fromFull = decodeHrefCandidate(href)
  if (fromFull) return fromFull
  if (stripped !== href) return decodeHrefCandidate(stripped)
  return null
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

/**
 * Collapse `.` / `..` and refuse only if the result leaves `/workspace/`.
 * Relative deliveries (`./output/report.md`) are resolved under `/workspace/`.
 * An absolute path that is not already under `/workspace/` is an escape.
 */
function normalizeWorkspaceFilePath(filePath: string): string | null {
  if (!filePath || filePath.includes('\0')) return null

  let asWorkspace: string
  if (filePath === '/workspace' || filePath.startsWith(WORKSPACE_PREFIX)) {
    asWorkspace = filePath
  } else if (filePath.startsWith('/')) {
    return null
  } else {
    asWorkspace = `${WORKSPACE_PREFIX}${filePath}`
  }

  const normalized = posixNormalize(asWorkspace).replace(/\/+$/, '') || '/'
  if (!normalized.startsWith(WORKSPACE_PREFIX)) return null
  if (normalized.length <= WORKSPACE_PREFIX.length) return null
  return normalized
}

export function getAgentFileApiPath(agentSlug: string, filePath: string): string | null {
  // Callers such as delivered files and bookmarks do not pass through
  // workspaceFilePathFromHref. Normalize dots, then refuse an escape.
  // Do not decode here: a literal "%2e%2e" filename is re-encoded safely.
  const normalized = normalizeWorkspaceFilePath(filePath)
  if (!normalized) return null
  return `/api/agents/${encodeURIComponent(agentSlug)}/files/${encodeWorkspaceFilePath(normalized)}`
}
