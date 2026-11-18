import { volumeBrowseSchema } from '@shared/lib/volumes/volume-browser-schema'

/**
 * Workspace paths as the agent tools hand them over: absolute container paths
 * under `/workspace`, or under `/mounts/<drive>` for a drive, where a trailing
 * slash is what marks a folder.
 *
 * These three rules were copied into half a dozen components before this file
 * existed, and had already started to disagree about trailing slashes. Every
 * place that needs to name or shorten a workspace path reads them from here.
 */

/** A path in one of the agent's drives, which it sees under `/mounts/<drive name>/`. */
export function isMountPath(filePath: string): boolean {
  return filePath.startsWith('/mounts/')
}

/** `/mounts/<name>/<path>` split into the mount name and the path inside that drive; null for any other path. */
export function parseMountPath(containerPath: string): { name: string; path: string } | null {
  const match = /^\/mounts\/([^/]+)(?:\/(.*))?$/s.exec(containerPath)
  if (!match) return null
  const path = (match[2] ?? '').replace(/\/+$/, '')
  return [match[1], path].every(part => volumeBrowseSchema.safeParse({ path: part }).success) ? { name: match[1], path } : null
}

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
