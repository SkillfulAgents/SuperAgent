import { zip } from 'fflate'

export interface FileWithPath {
  file: File
  relativePath?: string
}

export interface FolderGroup {
  folderName: string
  folderPath?: string // Electron: absolute path for server-side copy
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

  // In Electron, use webUtils.getPathForFile() via preload to get absolute paths
  // for dropped folders. dataTransfer.files contains a File entry per dropped item.
  const dtFiles = Array.from(dataTransfer.files)
  const folderPathMap = new Map<string, string>()
  for (const f of dtFiles) {
    const fp = window.electronAPI?.getPathForFile(f)
    if (fp) {
      folderPathMap.set(f.name, fp)
    }
  }

  const files: FileWithPath[] = []
  const folders: FolderGroup[] = []

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory) {
        const folderPath = folderPathMap.get(entry.name)
        if (folderPath) {
          // Electron: we have the absolute path, skip expensive file enumeration
          folders.push({ folderName: entry.name, folderPath, files: [] })
        } else {
          // Web: enumerate files for zipping
          const dirFiles = await readDirectoryFiles(
            entry as FileSystemDirectoryEntry,
            entry.name
          )
          folders.push({ folderName: entry.name, files: dirFiles })
        }
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
 * In Electron, File objects from <input> have a non-standard .path property
 * with the absolute filesystem path. Extract the folder's absolute path
 * by stripping inner path components from the first file's absolute path.
 * Works on macOS, Linux, and Windows (handles both / and \ separators).
 */
function getElectronFolderPath(firstFile: File, relativePath?: string): string | null {
  const f = firstFile as File & { path?: string }
  const rel = relativePath ?? f.webkitRelativePath
  if (!f.path || !rel) return null

  const relParts = rel.split('/')
  let folderPath = f.path
  for (let i = relParts.length - 1; i >= 1; i--) {
    const lastSep = Math.max(folderPath.lastIndexOf('/'), folderPath.lastIndexOf('\\'))
    if (lastSep === -1) return null
    folderPath = folderPath.slice(0, lastSep)
  }
  return folderPath
}

/**
 * Converts files from a webkitdirectory input into a FolderGroup.
 * Files selected via webkitdirectory have webkitRelativePath set.
 * In Electron, also extracts the folder's absolute path for server-side copy.
 */
export function getFolderFromDirectoryInput(files: FileList): FolderGroup | null {
  const fileArray = Array.from(files)
  if (fileArray.length === 0) return null

  const firstPath = fileArray[0].webkitRelativePath
  const folderName = firstPath ? firstPath.split('/')[0] : 'folder'
  const folderPath = getElectronFolderPath(fileArray[0]) ?? undefined

  return {
    folderName,
    folderPath,
    // In Electron, skip building the files array — we'll use fs.cp via folderPath
    files: folderPath ? [] : fileArray.map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    })),
  }
}

/**
 * Zip folder files in the browser using fflate.
 * Uses store-only (level 0) for speed — we just need bundling, not compression.
 * Uses the async zip() to avoid blocking the main thread.
 */
export async function zipFolderFiles(
  files: { file: File; relativePath: string }[]
): Promise<Blob> {
  // Read files sequentially to avoid memory spikes from parallel reads
  const data: Record<string, Uint8Array> = {}
  for (const f of files) {
    const buffer = await f.file.arrayBuffer()
    data[f.relativePath] = new Uint8Array(buffer)
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(data, { level: 0 }, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
}
