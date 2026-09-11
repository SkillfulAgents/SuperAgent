/**
 * Bringing files from this machine into an agent's workspace through the
 * agent's `FileOps`: one file (copied or moved) or a whole directory.
 *
 * The source is a host path — a skillset cache clone, a template checkout, a
 * folder chosen in the desktop file picker, an upload assembled in the temp
 * dir — that lives outside any workspace and is walked with `fs`. The
 * destination is a workspace path, so where it lands and whether it stays
 * inside the workspace is the actor's business, not the caller's. A
 * workspace on this machine takes a file in one filesystem operation, which
 * keeps its mode and costs a fraction of streaming it; any other workspace
 * takes it as a stream. That choice is made here, once.
 *
 * The rules are those of `copyDirectoryFiltered` in `file-storage`, which
 * this replaces for workspace destinations:
 *
 * - `.git`, `.skillset-metadata.json` and `.skillset-original.md` are never
 *   copied; `exclude` names more entries to skip, at any depth.
 * - With `followSymlinks`, a link is copied as what it points at (a file's
 *   bytes, a directory's tree) and the source root may itself be a link to a
 *   directory. A directory reached twice through links is copied once.
 *   Without it, a link is skipped with a warning, and a source root that is
 *   not a real directory is skipped whole.
 * - An empty directory is created as such. A file keeps its mode, so a
 *   script that was executable in the source is executable in the workspace.
 * - Nothing at the destination is removed first: files with the same name are
 *   replaced, others are left in place.
 *
 * The files of one directory are copied concurrently, as the plain copy was.
 * A workspace on this machine takes each file in one filesystem copy; any
 * other workspace has each file streamed through `write`.
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import pLimit from 'p-limit'
import { LocalFileOps } from './local-file-ops'
import type { FileOps } from './types'
import { joinWorkspacePath } from './workspace-path'

const ALWAYS_EXCLUDED = ['.git', '.skillset-metadata.json', '.skillset-original.md']

/** Files of one directory in flight at once. */
const FILE_CONCURRENCY = 8

export interface CopyIntoWorkspaceOptions {
  /** Entry names to skip anywhere in the tree, in addition to the built-in ones. */
  exclude?: readonly string[]
  /** Copy a link's target instead of skipping the link. Applies to the source root too. */
  followSymlinks?: boolean
}

export async function copyHostDirIntoWorkspace(
  files: FileOps,
  hostDir: string,
  workspaceDir: string,
  options: CopyIntoWorkspaceOptions = {},
): Promise<void> {
  const followSymlinks = options.followSymlinks === true
  const rootStat = followSymlinks ? await fs.promises.stat(hostDir) : await fs.promises.lstat(hostDir)
  if (!rootStat.isDirectory()) {
    console.warn(`copyHostDirIntoWorkspace: skipped non-directory source ${hostDir}`)
    return
  }
  const walk: Walk = {
    files,
    copyFile: files instanceof LocalFileOps ? (src, dest) => files.copyHostFile(src, dest) : streamFile(files),
    excluded: new Set([...ALWAYS_EXCLUDED, ...(options.exclude ?? [])]),
    followSymlinks,
    // Directories already copied, by real location, so a link back into the
    // tree does not recurse until the path is too long.
    visited: new Set(followSymlinks ? [await fs.promises.realpath(hostDir)] : []),
  }
  await copyTree(walk, hostDir, joinWorkspacePath(workspaceDir))
}

interface Walk {
  files: FileOps
  copyFile: (srcPath: string, destPath: string) => Promise<void>
  excluded: Set<string>
  followSymlinks: boolean
  visited: Set<string>
}

/** One file through `write`, with the source's mode. */
function streamFile(files: FileOps): Walk['copyFile'] {
  return async (srcPath, destPath) => {
    const stat = await fs.promises.stat(srcPath)
    await files.write(destPath, Readable.toWeb(fs.createReadStream(srcPath)) as ReadableStream<Uint8Array>, {
      mode: stat.mode & 0o777,
    })
  }
}

type EntryKind = 'file' | 'directory' | null

/** What a directory entry is, through a link when asked; null for anything that cannot be copied. */
async function kindOf(entry: fs.Dirent, hostPath: string, followSymlinks: boolean): Promise<EntryKind> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink() || !followSymlinks) return null
  try {
    const target = await fs.promises.stat(hostPath)
    if (target.isDirectory()) return 'directory'
    if (target.isFile()) return 'file'
  } catch {
    // A dangling link has nothing to copy.
  }
  return null
}

async function copyTree(walk: Walk, srcDir: string, destDir: string): Promise<void> {
  await walk.files.mkdir(destDir)
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true })
  const limit = pLimit(FILE_CONCURRENCY)
  const fileCopies: Promise<void>[] = []
  const subdirs: Array<{ srcPath: string; destPath: string }> = []
  for (const entry of entries) {
    if (walk.excluded.has(entry.name)) continue
    const srcPath = path.join(srcDir, entry.name)
    const destPath = joinWorkspacePath(destDir, entry.name)
    const kind = await kindOf(entry, srcPath, walk.followSymlinks)
    if (kind === 'directory') {
      subdirs.push({ srcPath, destPath })
    } else if (kind === 'file') {
      fileCopies.push(limit(() => walk.copyFile(srcPath, destPath)))
    } else {
      console.warn(`copyHostDirIntoWorkspace: skipped ${srcPath}`)
    }
  }
  await Promise.all(fileCopies)
  for (const { srcPath, destPath } of subdirs) {
    if (walk.followSymlinks) {
      const real = await fs.promises.realpath(srcPath)
      if (walk.visited.has(real)) {
        console.warn(`copyHostDirIntoWorkspace: skipped ${srcPath}, already copied through a link`)
        continue
      }
      walk.visited.add(real)
    }
    await copyTree(walk, srcPath, destPath)
  }
}

/** Copy one file from this machine into the workspace. */
export async function copyHostFileIntoWorkspace(files: FileOps, hostPath: string, workspacePath: string): Promise<void> {
  if (files instanceof LocalFileOps) {
    await files.copyHostFile(hostPath, workspacePath)
    return
  }
  await files.write(workspacePath, Readable.toWeb(fs.createReadStream(hostPath)) as ReadableStream<Uint8Array>)
}

/**
 * Move one file from this machine into the workspace: the source is gone
 * afterwards. A workspace on this machine renames it into place when the two
 * share a filesystem, so a file already written in full is not written again.
 */
export async function moveHostFileIntoWorkspace(
  files: FileOps,
  hostPath: string,
  workspacePath: string,
): Promise<{ size: number }> {
  if (files instanceof LocalFileOps) return files.moveHostFile(hostPath, workspacePath)
  const result = await files.write(workspacePath, Readable.toWeb(fs.createReadStream(hostPath)) as ReadableStream<Uint8Array>)
  await fs.promises.unlink(hostPath)
  return result
}
