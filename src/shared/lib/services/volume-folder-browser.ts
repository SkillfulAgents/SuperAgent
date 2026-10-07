import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { folderPickerQuerySchema, type FolderPickerListing } from '@shared/lib/volumes/folder-picker-schema'
import { VolumeError } from './volume-service'

/** Lists the workspace host's folders using the same access as local volume creation. */
export async function listVolumeFolders(raw: unknown): Promise<FolderPickerListing> {
  const query = folderPickerQuerySchema.parse(raw)
  const requested = query.path ?? homedir()
  if (!isAbsolute(requested)) throw new VolumeError('Choose an absolute folder', 400)

  let folder: string
  let entries: Dirent[]
  // Keep filesystem details out of errors, including paths of inaccessible symlink targets.
  try {
    folder = await realpath(requested)
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    throw new VolumeError('This folder is unavailable or cannot be opened', 400)
  }

  const folders: FolderPickerListing['folders'] = []
  // stat follows directory symlinks; inaccessible entries and files are omitted.
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory() || (entry.isSymbolicLink() && await stat(path).then(target => target.isDirectory()).catch(() => false))) {
      folders.push({ name: entry.name, path })
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

  const locations = [{ name: 'Home', path: homedir() }]
  if (platform() === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const path = `${letter}:\\`
      if (await stat(path).then(entry => entry.isDirectory()).catch(() => false)) {
        locations.push({ name: `${letter}:`, path })
      }
    }
  } else {
    locations.push({ name: 'Computer', path: parse(folder).root })
  }
  return { path: folder, parent: dirname(folder) === folder ? null : dirname(folder), folders, locations }
}
