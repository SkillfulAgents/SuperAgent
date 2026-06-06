/**
 * Path containment helpers — defense against directory traversal when we
 * join a trusted base directory with untrusted input (a URL path segment, a
 * ZIP entry name, a user-supplied filename) via `path.resolve`/`path.join`.
 *
 * Why not `resolved.startsWith(baseDir)`?
 *   A bare prefix check is unsafe: a SIBLING directory that shares the base's
 *   string prefix passes it. With base `/data/agent`, the path
 *   `/data/agent-victim/secret` satisfies `.startsWith('/data/agent')` yet is
 *   clearly outside the base. (See SUP-200.) Always decode the input first —
 *   encoded `..` (`%2e%2e%2f`) slips past URL normalization until
 *   `decodeURIComponent`.
 *
 * The correct check uses `path.relative(base, candidate)`: the candidate is
 * contained iff the relative path does not start with `..` and is not absolute.
 *
 * Exposed helpers:
 *   - isPathWithinDir(baseDir, candidate): boolean — for loops that `continue`
 *     on a bad entry, or callers that want to branch.
 *   - assertPathWithinDir(baseDir, candidate, message?): the resolved absolute
 *     path on success; throws on escape — for callers that fail the request.
 */

import path from 'path'

/**
 * True iff `candidate` resolves to a location inside (or equal to) `baseDir`.
 *
 * Both arguments are resolved to absolute paths first, so relative inputs are
 * interpreted against the process cwd — pass already-absolute paths (the usual
 * `path.resolve(baseDir, untrusted)` result) for predictable behavior.
 */
export function isPathWithinDir(baseDir: string, candidate: string): boolean {
  const base = path.resolve(baseDir)
  const resolved = path.resolve(candidate)
  const rel = path.relative(base, resolved)
  if (rel === '') return true // candidate === base
  // Escapes the base (`..`, `../x`) or is on a different root (absolute).
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false
  if (path.isAbsolute(rel)) return false
  return true
}

/**
 * Assert that `candidate` is contained within `baseDir`, returning the resolved
 * absolute path. Throws an Error (default message `Invalid path`) on escape.
 *
 * Use in request handlers that should reject with a 4xx — wrap the throw, or let
 * it propagate to the route's error boundary, as the call site requires.
 */
export function assertPathWithinDir(
  baseDir: string,
  candidate: string,
  message = 'Invalid path',
): string {
  if (!isPathWithinDir(baseDir, candidate)) {
    throw new Error(message)
  }
  return path.resolve(candidate)
}
