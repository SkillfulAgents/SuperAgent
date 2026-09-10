/**
 * Logical workspace paths and the error a file operation raises.
 *
 * A workspace path is what the agent sees: relative to the workspace root,
 * posix separators, `/workspace/…` accepted as a spelling of the same thing.
 * Where the workspace lives (a directory on this machine, a bucket prefix, a
 * sandbox volume) is the implementation's business, and so is containment:
 * a path that would leave the workspace, lexically or through a link, fails
 * with `WorkspaceFileError` instead of reaching anything.
 */
import path from 'path'

export type WorkspaceFileErrorCode =
  | 'invalid-path'
  | 'outside-workspace'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-directory'
  | 'not-accessible'

const STATUS: Record<WorkspaceFileErrorCode, 400 | 403 | 404> = {
  'invalid-path': 400,
  'outside-workspace': 400,
  'not-found': 404,
  'not-a-file': 404,
  'not-a-directory': 404,
  'not-accessible': 403,
}

const MESSAGE: Record<WorkspaceFileErrorCode, string> = {
  'invalid-path': 'Invalid path',
  'outside-workspace': 'Invalid path',
  'not-found': 'File not found',
  'not-a-file': 'Not a file',
  'not-a-directory': 'Not a directory',
  'not-accessible': 'File is not accessible',
}

export class WorkspaceFileError extends Error {
  /** The HTTP status a route answers with when it lets this error through. */
  readonly status: 400 | 403 | 404

  constructor(
    readonly code: WorkspaceFileErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGE[code])
    this.name = 'WorkspaceFileError'
    this.status = STATUS[code]
  }
}

/**
 * The canonical spelling of a workspace path: posix separators, no leading
 * slash, no `.` segments, no trailing slash, `''` for the root. Accepts
 * `/workspace` and `/workspace/…`. Throws `invalid-path` for NUL bytes, for an
 * absolute path that is not under `/workspace`, and for any `..` that would
 * climb above the root.
 */
export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new WorkspaceFileError('invalid-path')
  }
  let p = input.replace(/\\/g, '/')
  if (p === '/workspace' || p.startsWith('/workspace/')) {
    p = p.slice('/workspace'.length).replace(/^\/+/, '')
  }
  if (p.startsWith('/')) {
    // An absolute path that is not the agent's /workspace spelling.
    throw new WorkspaceFileError('invalid-path')
  }
  const normalized = path.posix.normalize(p === '' ? '.' : p)
  const trimmed = normalized === '.' ? '' : normalized.replace(/^\.\//, '').replace(/\/+$/, '')
  if (trimmed === '..' || trimmed.startsWith('../')) {
    throw new WorkspaceFileError('invalid-path')
  }
  return trimmed
}

/** Join path segments and normalize the result. */
export function joinWorkspacePath(...segments: string[]): string {
  return normalizeWorkspacePath(segments.filter((segment) => segment !== '').join('/'))
}

/** The last segment of a workspace path (`''` for the root). */
export function workspaceBasename(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

/** The parent of a workspace path (`''` for a top-level entry and for the root). */
export function workspaceDirname(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash)
}
