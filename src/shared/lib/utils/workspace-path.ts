/**
 * Collapse `.` / `..` and refuse a path that is not inside `/workspace`.
 * Pure string. Safe for the renderer. Folder vs file, and relative vs
 * absolute, stay at the call site.
 */

const WORKSPACE_ROOT = '/workspace'
const WORKSPACE_PREFIX = '/workspace/'

/** Absolute POSIX `.` / `..` collapse. Callers already require a leading `/`. */
function posixNormalize(input: string): string {
  const parts: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return `/${parts.join('/')}`
}

export function normalizeWorkspacePath(rawPath: string): string | null {
  if (!rawPath.startsWith('/') || rawPath.includes('\0')) return null
  const normalized = posixNormalize(rawPath)
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(WORKSPACE_PREFIX)) return null
  return normalized
}

/** A file inside `/workspace/`, not the workspace root itself. */
export function workspaceFilePath(rawPath: string): string | null {
  const normalized = normalizeWorkspacePath(rawPath)
  if (!normalized || normalized === WORKSPACE_ROOT) return null
  return normalized
}
