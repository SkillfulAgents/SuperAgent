import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { LocalFileOps, errnoCode, fromFsError } from '@shared/lib/agent-actor/local-file-ops'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { BaseMountableVolume, type VolumeEntry, type VolumeFile } from './base-mountable-volume'

/**
 * An entry as a listing reports it, never following a link: a link shows as an
 * empty file that cannot be read but can be deleted or moved. Anything else
 * that is not a file or a folder is left out, as is a name with a backslash,
 * which no request can name.
 */
function entryOf(name: string, stat: fs.Stats): VolumeEntry | null {
  if (name.includes('\\')) return null
  if (stat.isSymbolicLink()) return { name, kind: 'file', size: 0, mtimeMs: stat.mtimeMs }
  if (!stat.isFile() && !stat.isDirectory()) return null
  return { name, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, mtimeMs: stat.mtimeMs }
}

// A move is the only operation that can put a link where a checked folder was. Every operation is
// keyed by its volume's root, so a move waits for every earlier operation in its volume, or in a
// volume nested in or around it, and later ones wait for the move: nothing runs between a check and
// its act while a move lands. An upload streams outside the gate and holds it, alone like a move
// (the `move` flag means alone), only to publish, where its destination is resolved again, or to
// clean up a failed one.
type Running = { folder: string; move: boolean; done: Promise<unknown> }
const running = new Set<Running>()

async function gated<T>(folder: string, move: boolean, op: () => Promise<T>): Promise<T> {
  const before = [...running]
    .filter((r) => (move || r.move) && (isPathWithinDir(r.folder, folder) || isPathWithinDir(folder, r.folder)))
    .map((r) => r.done)
  const done = (async () => {
    await Promise.allSettled(before)
    return op()
  })()
  const entry = { folder, move, done }
  running.add(entry)
  try {
    return await done
  } finally {
    running.delete(entry)
  }
}

// Called after entry() checked the root, so a gone root is a miss (403) before it is a refusal (400).
function refuseRoot(volumePath: string): void {
  if (volumePath === '') throw new WorkspaceFileError('invalid-path', 'The volume root cannot be made, replaced, removed or moved')
}

/** A local volume's folder, by its real path. */
export const localVolumeConfigSchema = z.object({ path: z.string() })
export type LocalVolumeConfig = z.infer<typeof localVolumeConfigSchema>

/** Checks a folder picked for a new local volume, and names the volume after it. */
export async function prepareLocalVolume({ path: folder }: LocalVolumeConfig): Promise<{ name: string; config: LocalVolumeConfig }> {
  if (!path.isAbsolute(folder)) {
    throw new Error('The folder path must be an absolute path')
  }
  const resolved = await fs.promises.realpath(folder)
  if (!(await fs.promises.stat(resolved)).isDirectory()) {
    throw new Error('The folder path must be a directory')
  }
  // The name becomes /mounts/<name>, and the filesystem root has none.
  if (!path.basename(resolved)) {
    throw new Error('The folder must have a name')
  }
  return { name: path.basename(resolved), config: { path: resolved } }
}

/**
 * A volume backed by a folder on the client. Every folder a path passes through
 * must be a real folder inside it, never a link, and a link in the folder is
 * never followed, so removing a folder never reaches what its links point at.
 */
export class LocalMountableVolume extends BaseMountableVolume<LocalVolumeConfig> {
  readonly type = 'local'
  private readonly files: LocalFileOps

  constructor(id: string, name: string, config: LocalVolumeConfig) {
    super(id, name, config)
    this.files = new LocalFileOps(() => config.path)
  }

  override get hostPath(): string {
    return this.config.path
  }

  /** The entry itself, under a parent checked to lead where its name says. Delete and move act on a link as a link. */
  private async entry(volumePath: string): Promise<string> {
    // The folder is stored by its real path. One that now resolves elsewhere was replaced by a link: it is gone.
    const root = await fs.promises.realpath(this.config.path).catch(fromFsError)
    if (root !== this.config.path) throw new WorkspaceFileError('not-found')
    const parent = path.posix.dirname(volumePath)
    if (parent === '.') {
      // A root replaced by a file is a gone folder too.
      if (volumePath === '' && !(await fs.promises.lstat(root).catch(fromFsError)).isDirectory()) throw new WorkspaceFileError('not-found')
      return path.join(root, volumePath)
    }
    const named = path.join(root, parent)
    const real = await fs.promises.realpath(named).catch(fromFsError)
    if (!isPathWithinDir(root, real)) throw new WorkspaceFileError('outside-workspace')
    if (real !== named) throw new WorkspaceFileError('not-accessible', 'A path cannot pass through a link')
    return path.join(named, path.posix.basename(volumePath))
  }

  list(volumePath: string): Promise<VolumeEntry[]> {
    return gated(this.config.path, false, async () => {
      const abs = await this.entry(volumePath)
      if (!(await fs.promises.lstat(abs).catch(fromFsError)).isDirectory()) throw new WorkspaceFileError('not-a-directory')
      const names = await fs.promises.readdir(abs).catch(fromFsError)
      const entries = await Promise.all(names.map(async (name) => {
        // An entry gone since the listing is left out.
        const stat = await fs.promises.lstat(path.join(abs, name)).catch(fromFsError).catch((error) => {
          if (error instanceof WorkspaceFileError && error.code === 'not-found') return null
          throw error
        })
        return stat && entryOf(name, stat)
      }))
      return entries.filter((entry) => entry !== null)
    })
  }

  stat(volumePath: string): Promise<VolumeEntry> {
    const op = async () => {
      const stat = await fs.promises.lstat(await this.entry(volumePath)).catch(fromFsError)
      const entry = entryOf(path.posix.basename(volumePath), stat)
      if (!entry) throw new WorkspaceFileError('not-found')
      return entry
    }
    // A stat of the root only reads a snapshot (the health check), and every operation on its contents
    // checks the path again under the gate, so it never waits behind a move.
    return volumePath === '' ? op() : gated(this.config.path, false, op)
  }

  read(volumePath: string): Promise<VolumeFile> {
    return gated(this.config.path, false, async () => {
      if ((await fs.promises.lstat(await this.entry(volumePath)).catch(fromFsError)).isSymbolicLink()) {
        throw new WorkspaceFileError('not-accessible', 'A link cannot be read')
      }
      // A confined open reads the real file it checked, so a link moved in afterwards cannot redirect it.
      const file = await this.files.open(volumePath, { confined: true })
      try {
        return { size: await file.size(), stream: (range) => file.stream(range), close: () => file.close() }
      } catch (error) {
        await file.close().catch(() => {})
        throw error
      }
    })
  }

  async write(volumePath: string, body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      // An early refusal only: the publish below checks again under the gate.
      await this.entry(volumePath)
      refuseRoot(volumePath)
      // The body streams in outside the gate, so a slow upload never holds up a move. The publish is
      // gated, and refused unless the path, checked again, still leads where the file was staged. The
      // atomic rename replaces a link at the target with the file, as a move onto it does, never what
      // it points at. A parent deleted meanwhile stays deleted.
      await this.files.write(volumePath, body, {
        confined: true,
        existingParent: true,
        exactRoot: true,
        lock: (fn) => gated(this.config.path, true, fn),
        beforePublish: async (destination) => {
          if ((await this.entry(volumePath)) !== destination) throw new WorkspaceFileError('not-accessible', 'The folder changed during the upload')
        },
      })
    } catch (error) {
      await body.cancel().catch(() => {})
      throw error
    }
  }

  delete(volumePath: string): Promise<void> {
    return gated(this.config.path, false, async () => {
      const abs = await this.entry(volumePath)
      refuseRoot(volumePath)
      const stat = await fs.promises.lstat(abs).catch(fromFsError)
      await (stat.isDirectory() ? fs.promises.rmdir(abs) : fs.promises.unlink(abs)).catch(fromFsError)
    })
  }

  mkdir(volumePath: string): Promise<void> {
    return gated(this.config.path, false, async () => {
      const abs = await this.entry(volumePath)
      refuseRoot(volumePath)
      await fs.promises.mkdir(abs).catch(fromFsError)
    })
  }

  move(from: string, to: string): Promise<void> {
    return gated(this.config.path, true, async () => {
      const source = await this.entry(from)
      refuseRoot(from)
      // A missing source, or one under a file, is a miss: rename's ENOTDIR then only means a folder onto a file.
      await fs.promises.lstat(source).catch(fromFsError)
      const target = await this.entry(to).catch((error) => {
        if (error instanceof WorkspaceFileError && error.code === 'not-found') throw new WorkspaceFileError('not-a-directory', 'The destination folder does not exist')
        throw error
      })
      refuseRoot(to)
      if (!(await fs.promises.lstat(path.dirname(target)).catch(fromFsError)).isDirectory()) {
        throw new WorkspaceFileError('not-a-directory', 'The destination folder does not exist')
      }
      await fs.promises.rename(source, target).catch((error) => {
        const code = errnoCode(error)
        // A folder moved into itself, or onto another filesystem, cannot be renamed.
        if (code === 'EINVAL' || code === 'EXDEV') throw new WorkspaceFileError('invalid-path')
        // Either side a folder and the other a file: a conflict (409), where reading a folder is a miss (404).
        if (code === 'EISDIR' || code === 'ENOTDIR') throw new WorkspaceFileError('already-exists')
        fromFsError(error)
      })
    })
  }
}
