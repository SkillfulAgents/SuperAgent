import { workspaceFilePath } from '@shared/lib/utils/workspace-path'

const WORKSPACE_PREFIX = '/workspace/'

/** A `file:` URL whose path stays in `/workspace/`. Hosted `file://host/...` is refused. */
export function workspaceFilePathFromFileUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || parsed.hostname !== '') return null
    let pathname: string
    try {
      pathname = decodeURIComponent(parsed.pathname)
    } catch {
      pathname = parsed.pathname
    }
    return workspaceFilePath(pathname)
  } catch {
    return null
  }
}

function decodeHrefCandidate(pathOnly: string): string | null {
  if (!pathOnly.startsWith(WORKSPACE_PREFIX) && pathOnly !== '/workspace') return null

  let decoded: string
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    decoded = pathOnly
  }
  return workspaceFilePath(decoded)
}

/**
 * Chat markdown file links that point at a container workspace path.
 * `/workspace/...` counts. `file:` is rewritten to that form by the markdown
 * transform before this runs. Bare filenames, in-app routes, and other schemes do not.
 * Tries the full destination first so a literal `#` or `?` in the name is kept,
 * then falls back to the query/hash-stripped form.
 * Decodes once so a CommonMark `%20` becomes a real space before the file API encodes.
 * A malformed percent-escape keeps the raw name.
 * `.` / `..` collapse; a path that leaves `/workspace/` is refused.
 */
export function workspaceFilePathFromHref(href: string | undefined | null): string | null {
  if (!href) return null
  const stripped = href.split(/[?#]/)[0]
  const fromFull = decodeHrefCandidate(href)
  if (fromFull) return fromFull
  if (stripped !== href) return decodeHrefCandidate(stripped)
  return null
}

const HREF_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function parentWorkspaceDir(filePath: string): string | null {
  const base = normalizeWorkspaceFilePath(filePath)
  if (!base) return null
  const slash = base.lastIndexOf('/')
  if (slash <= 0) return null
  return base.slice(0, slash)
}

/**
 * Resolve a markdown href against an open workspace file.
 * `/workspace/` uses workspaceFilePathFromHref. `file:` is rewritten first.
 * A relative name joins the open file's folder, then the same collapse/refuse.
 * Fragments, queries, schemes, and other absolute paths stay unresolved.
 */
export function workspaceFilePathFromRelativeHref(
  href: string | undefined | null,
  fromFilePath: string,
): string | null {
  const absolute = workspaceFilePathFromHref(href)
  if (absolute) return absolute
  if (
    !href
    || href.startsWith('#')
    || href.startsWith('?')
    || href.startsWith('/')
    || HREF_SCHEME.test(href)
  ) {
    return null
  }
  const dir = parentWorkspaceDir(fromFilePath)
  if (!dir) return null
  return workspaceFilePathFromHref(`${dir}/${href}`)
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
 * Relative deliveries (`./output/report.md`) are resolved under `/workspace/`.
 * An absolute path that is not already under `/workspace/` is an escape.
 */
function asWorkspaceAbsolute(filePath: string): string | null {
  if (!filePath || filePath.includes('\0')) return null
  if (filePath === '/workspace' || filePath.startsWith(WORKSPACE_PREFIX)) return filePath
  if (filePath.startsWith('/')) return null
  return `${WORKSPACE_PREFIX}${filePath}`
}

export function normalizeWorkspaceFilePath(filePath: string): string | null {
  const asWorkspace = asWorkspaceAbsolute(filePath)
  if (!asWorkspace) return null
  return workspaceFilePath(asWorkspace)
}

/** Stripped `?#` form, or null when it is the same path or leaves `/workspace/`. */
export function fallbackWorkspaceFilePath(filePath: string): string | null {
  const stripped = filePath.split(/[?#]/)[0]
  if (!stripped || stripped === filePath) return null
  return normalizeWorkspaceFilePath(stripped)
}

export function getAgentFileApiPath(agentSlug: string, filePath: string): string | null {
  // Callers such as delivered files and bookmarks do not pass through
  // workspaceFilePathFromHref. Do not decode here: a literal "%2e%2e" filename
  // is re-encoded safely.
  const normalized = normalizeWorkspaceFilePath(filePath)
  if (!normalized) return null
  return `/api/agents/${encodeURIComponent(agentSlug)}/files/${encodeWorkspaceFilePath(normalized)}`
}
