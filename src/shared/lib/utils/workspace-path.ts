/**
 * Workspace paths as the agent tools hand them over: absolute container paths
 * under `/workspace`, where a trailing slash is what marks a folder.
 *
 * These three rules were copied into half a dozen components before this file
 * existed, and had already started to disagree about trailing slashes. Every
 * place that needs to name or shorten a workspace path reads them from here.
 */

/** A folder is written with a trailing slash; a file never is. */
export function isFolderPath(filePath: string): boolean {
  return filePath.endsWith('/')
}

/** Last path segment, tolerating a trailing slash: `/workspace/out/a.txt` → `a.txt`. */
export function getPathName(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  return trimmed.split('/').pop() || filePath
}

/**
 * Path relative to the workspace root, without a trailing slash:
 * `/workspace/out/a.txt` → `out/a.txt`.
 *
 * The prefix has to end at a segment boundary. Without the lookahead a
 * `/workspaceX/a.txt` — a sibling directory, not the workspace — came back as
 * `X/a.txt`, which reads as a path inside the workspace and is not one.
 */
export function toWorkspaceRelativePath(filePath: string): string {
  return filePath.replace(/^\/workspace(?=\/|$)\/?/, '').replace(/\/+$/, '')
}

/**
 * One spelling for a file path inside the workspace, relative, so two
 * spellings of the same file compare equal: `/workspace//out/./a.md`,
 * `out/b/../a.md` and `/workspace/out/a.md` all give `out/a.md`. Null for a
 * path outside the workspace, one that climbs above it, or the root itself.
 */
export function canonicalWorkspacePath(filePath: string): string | null {
  let rest = filePath
  if (rest === '/workspace' || rest.startsWith('/workspace/')) rest = rest.slice('/workspace'.length)
  else if (rest.startsWith('/')) return null
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length > 0 ? segments.join('/') : null
}
