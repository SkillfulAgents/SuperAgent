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
