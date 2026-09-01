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

import fs from 'fs'
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

/**
 * Symlink-aware containment: true iff `candidate`'s REAL location is inside
 * (or equal to) `baseDir`'s real location.
 *
 * `isPathWithinDir` compares path STRINGS and never follows a link, so a
 * symlink planted inside `baseDir` that points outside it passes. When the
 * base directory is writable by an untrusted party — an agent's bind-mounted
 * workspace — that is a real escape: a link named after another agent's
 * session resolves to that agent's transcript while still looking local.
 *
 * Resolves symlinks on the deepest EXISTING prefix of `candidate` (a
 * not-yet-created leaf can't be a link, and its name was already validated by
 * `isPathWithinDir`), then re-appends the missing tail and re-checks
 * containment against the real base. Any fs error is treated as "not
 * contained" — fail closed. Follows links via `fs.existsSync`, so a dangling
 * link resolves to its (contained) parent and reads as absent downstream.
 */
export function isRealPathWithinDir(baseDir: string, candidate: string): boolean {
  try {
    const realBase = safeRealpath(baseDir)
    let existing = path.resolve(candidate)
    const tail: string[] = []
    while (!fs.existsSync(existing)) {
      tail.unshift(path.basename(existing))
      const parent = path.dirname(existing)
      if (parent === existing) return false // walked past the root
      existing = parent
    }
    const realExisting = safeRealpath(existing)
    const realCandidate = tail.length > 0 ? path.join(realExisting, ...tail) : realExisting
    return isPathWithinDir(realBase, realCandidate)
  } catch {
    return false
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Sanitize an externally-supplied filename into a safe basename for writing
 * under a trusted uploads directory.
 *
 * Untrusted names (chat attachments, uploaded files) may carry directory
 * components or traversal. We drop NUL bytes, strip any directory components
 * (POSIX and Windows separators) and `..` traversal by keeping only the last
 * segment, remove leading dots (hidden files / bare `.`/`..`), and replace any
 * remaining path-unsafe characters. Falls back to `file` when nothing usable
 * remains. (SUP-231)
 *
 * This yields a basename only — it never preserves nested directory structure.
 * Pair it with `assertPathWithinDir` for defense in depth at the write site.
 */
export function sanitizeUploadFilename(filename: string): string {
  // Drop NUL bytes, then take the last segment so directory components
  // (including `..`) cannot survive — split on both `/` and `\`.
  const raw = String(filename ?? '').replace(/\0/g, '')
  const segments = raw.split(/[/\\]/)
  let base = segments[segments.length - 1] ?? ''
  // Strip leading dots (hidden files, bare `.`/`..`).
  base = base.replace(/^\.+/, '')
  // Replace any remaining path-unsafe characters.
  base = base.replace(/[^A-Za-z0-9._-]/g, '_')
  if (base === '' || base === '.' || base === '..') return 'file'
  return base
}
