import type { ByteRange, FileKind } from '@shared/lib/agent-actor/types'
import { getMounts } from '@shared/lib/services/mount-service'
import { ClientFolderOps } from './client-folder-ops'

/** One entry of a volume, with what a WebDAV listing reports. `name` is '' for the volume root. */
export interface VolumeEntry {
  name: string
  kind: FileKind
  size: number
  mtimeMs: number
}

/**
 * A file opened for reading: its size and bytes come from the same open. Call `stream` once, which
 * releases the open when it ends, or `close` when sending no body.
 */
export interface VolumeFile {
  size: number
  stream(range?: ByteRange): ReadableStream<Uint8Array>
  close(): Promise<void>
}

/**
 * The operations a volume supports: the contract every source's driver implements.
 * Paths arrive normalized: relative to the volume root, '' being the root, with no `.` or `..`
 * segments. Failures are `WorkspaceFileError`s: `not-found` for a missing path, and for a missing
 * parent on write or mkdir; `not-a-directory` for a move into a folder that is not there;
 * `not-a-file` for a write onto a folder; `already-exists` for mkdir onto an entry; `not-empty`
 * for deleting a full folder; `not-accessible` for an entry the source will not serve. The root is
 * never made, removed, moved or replaced: a driver refuses those with `invalid-path`.
 */
export interface VolumeOps {
  list(path: string): Promise<VolumeEntry[]>
  stat(path: string): Promise<VolumeEntry>
  read(path: string): Promise<VolumeFile>
  /** Replace a whole file. */
  write(path: string, body: ReadableStream<Uint8Array>): Promise<void>
  /** Remove a file or an empty folder. */
  delete(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  move(from: string, to: string): Promise<void>
}

/**
 * The one place a volume's source is learned. Each mounts.json row is one
 * agent's volume and its id is the volume id, so a volume not attached to this
 * agent resolves to nothing.
 */
export async function resolveVolume(agentSlug: string, volumeId: string): Promise<VolumeOps | null> {
  const mount = (await getMounts(agentSlug)).find((m) => m.id === volumeId)
  return mount ? new ClientFolderOps(mount.hostPath) : null
}
