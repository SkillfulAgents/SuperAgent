/**
 * Bringing files from this machine into a workspace.
 *
 * The sources are host paths: a folder chosen in the desktop file picker, an
 * upload assembled in the temp dir. A workspace on this machine takes each
 * file in one filesystem operation, which keeps the file's mode and costs a
 * fraction of streaming it; any other workspace takes it as a stream through
 * the `FileOps` contract. The choice is made here, once, so the callers do
 * not know which kind of workspace they have.
 */
import fs from 'fs'
import { Readable } from 'stream'
import { LocalFileOps } from './local-file-ops'
import type { FileOps } from './types'

function hostFileStream(hostPath: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(hostPath)) as ReadableStream<Uint8Array>
}

/** Copy one file from this machine into the workspace. */
export async function copyHostFileIntoWorkspace(files: FileOps, hostPath: string, workspacePath: string): Promise<void> {
  if (files instanceof LocalFileOps) {
    await files.copyHostFile(hostPath, workspacePath)
    return
  }
  await files.write(workspacePath, hostFileStream(hostPath))
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
  const result = await files.write(workspacePath, hostFileStream(hostPath))
  await fs.promises.unlink(hostPath)
  return result
}
