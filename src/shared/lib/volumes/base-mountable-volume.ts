import type { ByteRange, FileKind } from '@shared/lib/agent-actor/types'
import type { VolumeCacheMode, VolumeType } from '@shared/lib/types/mount'

/** One entry of a volume, with what a WebDAV listing reports. `name` is '' for the volume root. */
export interface VolumeEntry {
  name: string
  kind: FileKind
  size: number
  mtimeMs: number
}

/**
 * A file opened for reading: its size and bytes come from the same open. Call `stream` once, which
 * releases the open when it ends, or `close` when sending no body. Await stream
 * establishment before sending HTTP headers so remote failures retain their status.
 */
export interface VolumeFile {
  size: number
  stream(range?: ByteRange): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
  close(): Promise<void>
}

/** Where a volume appears in the container. */
export function mountPathOf(name: string): string {
  return `/mounts/${name}`
}

/**
 * A volume: one source's files, mounted in the container at its mount path. Each source is a subclass
 * that owns its `config`. Paths arrive normalized: relative to the volume root, '' being the root, with
 * no `.` or `..` segments. Failures are `WorkspaceFileError`s: `not-found` for a missing path, and for a
 * missing parent on write or mkdir; `not-a-directory` for a move into a folder that is not there;
 * `not-a-file` for a write onto a folder; `already-exists` for mkdir onto an entry; `not-empty` for
 * deleting a full folder; `not-accessible` for an entry the source will not serve. The root is never
 * made, removed, moved or replaced: a subclass refuses those with `invalid-path`.
 */
export abstract class BaseMountableVolume<C> {
  abstract readonly type: VolumeType
  abstract readonly cacheMode: VolumeCacheMode
  /** Case semantics belong to the source, independently of its cache policy. */
  readonly caseInsensitive: boolean = false

  constructor(readonly id: string, readonly name: string, readonly config: C) {}

  get mountPath(): string {
    return mountPathOf(this.name)
  }

  /** The volume's folder on the machine that runs the agent, or null for a source that has none. */
  get hostPath(): string | null {
    return null
  }

  /** What the card shows for a remote source, or null for a source whose host path says it. */
  get sourceLabel(): string | null {
    return null
  }

  abstract list(path: string): Promise<VolumeEntry[]>
  abstract stat(path: string): Promise<VolumeEntry>
  /** Advisory root health for settings and mount status. Remote drivers may cache it. */
  health(): Promise<VolumeEntry> { return this.stat('') }
  abstract read(path: string): Promise<VolumeFile>
  /** Replace a whole file. */
  abstract write(path: string, body: ReadableStream<Uint8Array>): Promise<void>
  /** Remove a file or an empty folder. */
  abstract delete(path: string): Promise<void>
  abstract mkdir(path: string): Promise<void>
  abstract move(from: string, to: string): Promise<void>
}
