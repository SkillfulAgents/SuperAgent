export interface FileWithPath {
  file: File
  relativePath?: string
}

export interface FolderGroup {
  folderName: string
  files: { file: File; relativePath: string }[]
}

export interface DataTransferResult {
  files: FileWithPath[]
  folders: FolderGroup[]
}

async function readDirectoryFiles(
  entry: FileSystemDirectoryEntry,
  basePath: string
): Promise<{ file: File; relativePath: string }[]> {
  const reader = entry.createReader()
  const entries: FileSystemEntry[] = []

  // readEntries may return results in batches
  let batch: FileSystemEntry[]
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    entries.push(...batch)
  } while (batch.length > 0)

  const results = await Promise.all(
    entries.map(async (e) => {
      const childPath = `${basePath}/${e.name}`
      if (e.isFile) {
        const file = await new Promise<File>((resolve, reject) => {
          ;(e as FileSystemFileEntry).file(resolve, reject)
        })
        return [{ file, relativePath: childPath }]
      }
      if (e.isDirectory) {
        return readDirectoryFiles(e as FileSystemDirectoryEntry, childPath)
      }
      return []
    })
  )
  return results.flat()
}

/**
 * Extracts files and folders from a DataTransfer.
 * Directories are returned as FolderGroups preserving nested structure.
 * Plain files are returned individually.
 */
export async function getItemsFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<DataTransferResult> {
  // Must access items synchronously before the event clears
  const items = Array.from(dataTransfer.items)
  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => entry != null)

  if (entries.length === 0) {
    // Fallback: no entries API
    return {
      files: Array.from(dataTransfer.files).map((file) => ({ file })),
      folders: [],
    }
  }

  const files: FileWithPath[] = []
  const folders: FolderGroup[] = []

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory) {
        const dirFiles = await readDirectoryFiles(
          entry as FileSystemDirectoryEntry,
          entry.name
        )
        folders.push({ folderName: entry.name, files: dirFiles })
      } else if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => {
          ;(entry as FileSystemFileEntry).file(resolve, reject)
        })
        files.push({ file })
      }
    })
  )

  return { files, folders }
}

/**
 * Converts files from a webkitdirectory input into a FolderGroup.
 * Files selected via webkitdirectory have webkitRelativePath set.
 */
export function getFolderFromDirectoryInput(files: FileList): FolderGroup | null {
  const fileArray = Array.from(files)
  if (fileArray.length === 0) return null

  const firstPath = fileArray[0].webkitRelativePath
  const folderName = firstPath ? firstPath.split('/')[0] : 'folder'

  return {
    folderName,
    files: fileArray.map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    })),
  }
}
