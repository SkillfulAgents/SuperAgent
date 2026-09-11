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
 *   directory. Without it, a link is skipped with a warning, and a source
 *   root that is not a real directory is skipped whole.
 * - An empty directory is created as such; a file is streamed, not buffered.
 * - Nothing at the destination is removed first: files with the same name are
 *   replaced, others are left in place.
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { LocalFileOps } from './local-file-ops'
import type { FileOps } from './types'
import { joinWorkspacePath } from './workspace-path'

const ALWAYS_EXCLUDED = ['.git', '.skillset-metadata.json', '.skillset-original.md']

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
  const rootStat = options.followSymlinks ? await fs.promises.stat(hostDir) : await fs.promises.lstat(hostDir)
  if (!rootStat.isDirectory()) {
    console.warn(`copyHostDirIntoWorkspace: skipped non-directory source ${hostDir}`)
    return
  }
  const excluded = new Set([...ALWAYS_EXCLUDED, ...(options.exclude ?? [])])
  await copyTree(files, hostDir, joinWorkspacePath(workspaceDir), excluded, options.followSymlinks === true)
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

async function copyTree(
  files: FileOps,
  srcDir: string,
  destDir: string,
  excluded: Set<string>,
  followSymlinks: boolean,
): Promise<void> {
  await files.mkdir(destDir)
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue
    const srcPath = path.join(srcDir, entry.name)
    const destPath = joinWorkspacePath(destDir, entry.name)
    const kind = await kindOf(entry, srcPath, followSymlinks)
    if (kind === 'directory') {
      await copyTree(files, srcPath, destPath, excluded, followSymlinks)
    } else if (kind === 'file') {
      await files.write(destPath, Readable.toWeb(fs.createReadStream(srcPath)) as ReadableStream<Uint8Array>)
    } else {
      console.warn(`copyHostDirIntoWorkspace: skipped ${srcPath}`)
    }
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
