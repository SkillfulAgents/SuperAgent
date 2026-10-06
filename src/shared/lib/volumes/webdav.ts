import { WorkspaceFileError, normalizeWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
import type { VolumeEntry } from './base-mountable-volume'

/**
 * WebDAV as rclone's client speaks it: request paths and headers to volume
 * paths, a listing to a multistatus body, and a failure to a status. The only
 * place a volume failure becomes a protocol status.
 */

/**
 * The volume path a request URL names: what follows `base` (`/api/volumes/<id>`),
 * decoded and normalized, so no driver sees a `..` segment. A backslash is refused,
 * since the normalizer would read it as a separator and name a different entry.
 */
export function volumePathOf(urlPath: string, base: string): string {
  if (urlPath !== base && !urlPath.startsWith(`${base}/`)) throw new WorkspaceFileError('outside-workspace')
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.slice(base.length))
  } catch {
    throw new WorkspaceFileError('invalid-path')
  }
  if (decoded.includes('\\')) throw new WorkspaceFileError('invalid-path')
  return normalizeWorkspacePath(decoded.replace(/^\/+/, ''))
}

/** A MOVE's destination, which must stay inside the same volume. */
export function destinationOf(header: string | undefined, base: string): string {
  if (!header) throw new WorkspaceFileError('invalid-path', 'MOVE needs a Destination')
  // A URL parse reads a backslash as a separator, before volumePathOf could refuse it.
  if (header.includes('\\')) throw new WorkspaceFileError('invalid-path')
  let destination: URL
  try {
    destination = new URL(header, 'http://volume')
  } catch {
    throw new WorkspaceFileError('invalid-path')
  }
  return volumePathOf(destination.pathname, base)
}

/** PROPFIND reaches one level: the path itself (0), or it and its children (1). */
export function depthOf(header: string | undefined): 0 | 1 {
  if (header === '0') return 0
  if (header === '1') return 1
  throw new WorkspaceFileError('not-accessible', 'Depth must be 0 or 1')
}

function hrefOf(base: string, volumePath: string, entry: VolumeEntry): string {
  const encoded = volumePath === '' ? '' : `/${volumePath.split('/').map(encodeURIComponent).join('/')}`
  return `${base}${encoded}${entry.kind === 'directory' ? '/' : ''}`
}

/** A PROPFIND answer for each entry, keyed by its volume path. */
export function multistatus(base: string, items: { path: string; entry: VolumeEntry }[]): string {
  const responses = items.map(({ path, entry }) => [
    `<d:response><d:href>${hrefOf(base, path, entry)}</d:href><d:propstat><d:prop>`,
    entry.kind === 'directory' ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>',
    `<d:getcontentlength>${entry.size}</d:getcontentlength>`,
    `<d:getlastmodified>${new Date(entry.mtimeMs).toUTCString()}</d:getlastmodified>`,
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
  ].join(''))
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`
}

/**
 * The status for a failed request on `volumePath`. The root never answers 404,
 * since rclone mounts a 404 root as an empty folder: it answers 403. MKCOL on an existing
 * folder is 405, which rclone reads as "already there". PUT onto a folder is 405
 * too. A missing parent on create or move is 409.
 */
export function statusOf(method: string, volumePath: string, error: WorkspaceFileError): WorkspaceFileError['status'] | 405 {
  if (volumePath === '' && error.status === 404) return 403
  if (method === 'MKCOL' && error.code === 'already-exists') return 405
  if (method === 'PUT' && error.code === 'not-a-file') return 405
  if (method === 'MOVE' && error.code === 'not-a-directory') return 409
  if ((method === 'MKCOL' || method === 'PUT') && (error.code === 'not-found' || error.code === 'not-a-directory')) return 409
  return error.status
}
