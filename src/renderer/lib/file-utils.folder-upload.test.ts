// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getFolderFromDirectoryInput,
  getItemsFromDataTransfer,
  zipFolderFiles,
} from './file-utils'

/**
 * Helper to create a mock FileList from an array of partial File objects.
 */
function createMockFileList(
  files: Array<{ name: string; webkitRelativePath?: string; path?: string; size?: number }>
): FileList {
  const fileObjects = files.map((f) => {
    const file = new File(['x'.repeat(f.size ?? 0)], f.name)
    Object.defineProperty(file, 'webkitRelativePath', {
      value: f.webkitRelativePath ?? '',
      writable: false,
    })
    if (f.path !== undefined) {
      Object.defineProperty(file, 'path', {
        value: f.path,
        writable: false,
      })
    }
    return file
  })

  const list = Object.create(FileList.prototype) as FileList & {
    [index: number]: File
  }

  fileObjects.forEach((file, i) => {
    list[i] = file
  })

  Object.defineProperty(list, 'length', {
    value: fileObjects.length,
    writable: false,
  })

  Object.defineProperty(list, 'item', {
    value: (index: number) => fileObjects[index] ?? null,
    writable: false,
  })

  list[Symbol.iterator] = function () {
    return fileObjects[Symbol.iterator]()
  }

  return list
}

function createMockDirEntry(
  name: string,
  children: FileSystemEntry[]
): Partial<FileSystemDirectoryEntry> {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () =>
      ({
        readEntries: (() => {
          let called = false
          return (successCb: (entries: FileSystemEntry[]) => void) => {
            if (!called) {
              called = true
              successCb(children)
            } else {
              successCb([])
            }
          }
        })(),
      }) as unknown as FileSystemDirectoryReader,
  }
}

function createMockFileEntry(
  name: string,
  file: File
): Partial<FileSystemFileEntry> {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (successCb: FileCallback) => successCb(file),
  }
}

// ============================================================================
// getFolderFromDirectoryInput — Electron folderPath extraction
// ============================================================================

describe('getFolderFromDirectoryInput — Electron folderPath', () => {
  it('extracts folderPath on macOS/Linux when File has .path (Electron)', () => {
    const fileList = createMockFileList([
      {
        name: 'index.ts',
        webkitRelativePath: 'my-project/src/index.ts',
        path: '/Users/joe/code/my-project/src/index.ts',
      },
      {
        name: 'utils.ts',
        webkitRelativePath: 'my-project/src/utils.ts',
        path: '/Users/joe/code/my-project/src/utils.ts',
      },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.folderPath).toBe('/Users/joe/code/my-project')
    expect(result!.folderName).toBe('my-project')
  })

  it('extracts folderPath on Windows when File has .path (Electron)', () => {
    const fileList = createMockFileList([
      {
        name: 'index.ts',
        webkitRelativePath: 'my-project/src/index.ts',
        path: 'C:\\Users\\joe\\code\\my-project\\src\\index.ts',
      },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.folderPath).toBe('C:\\Users\\joe\\code\\my-project')
  })

  it('handles file directly in folder root', () => {
    const fileList = createMockFileList([
      {
        name: 'readme.md',
        webkitRelativePath: 'my-project/readme.md',
        path: '/Users/joe/my-project/readme.md',
      },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result!.folderPath).toBe('/Users/joe/my-project')
  })

  it('returns undefined folderPath when File has no .path (browser)', () => {
    const fileList = createMockFileList([
      { name: 'index.ts', webkitRelativePath: 'my-project/src/index.ts' },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.folderPath).toBeUndefined()
    // Files should still be enumerated for zip fallback
    expect(result!.files).toHaveLength(1)
  })
})

// ============================================================================
// getItemsFromDataTransfer — Electron drag-and-drop folderPath
// ============================================================================

describe('getItemsFromDataTransfer — Electron drag-and-drop', () => {
  let originalElectronAPI: typeof window.electronAPI

  beforeEach(() => {
    originalElectronAPI = window.electronAPI
  })

  afterEach(() => {
    window.electronAPI = originalElectronAPI
  })

  it('sets folderPath and skips file enumeration when electronAPI.getPathForFile is available', async () => {
    const nestedFile = new File(['content'], 'nested.txt')
    const dirEntry = createMockDirEntry('my-folder', [
      createMockFileEntry('nested.txt', nestedFile) as unknown as FileSystemEntry,
    ])

    const folderFile = new File([], 'my-folder')

    window.electronAPI = {
      getPathForFile: vi.fn((f: File) => {
        if (f.name === 'my-folder') return '/Users/joe/Desktop/my-folder'
        return ''
      }),
    } as any

    const mockDataTransfer = {
      items: [{ webkitGetAsEntry: () => dirEntry }],
      files: [folderFile],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)

    expect(result.folders).toHaveLength(1)
    expect(result.folders[0].folderName).toBe('my-folder')
    expect(result.folders[0].folderPath).toBe('/Users/joe/Desktop/my-folder')
    // Files should NOT be enumerated in Electron path
    expect(result.folders[0].files).toHaveLength(0)
  })

  it('enumerates files when electronAPI is not available (web)', async () => {
    const nestedFile = new File(['content'], 'nested.txt')
    const dirEntry = createMockDirEntry('my-folder', [
      createMockFileEntry('nested.txt', nestedFile) as unknown as FileSystemEntry,
    ])

    window.electronAPI = undefined

    const mockDataTransfer = {
      items: [{ webkitGetAsEntry: () => dirEntry }],
      files: [],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)

    expect(result.folders).toHaveLength(1)
    expect(result.folders[0].folderPath).toBeUndefined()
    // Files should be enumerated for zip
    expect(result.folders[0].files).toHaveLength(1)
    expect(result.folders[0].files[0].file).toBe(nestedFile)
  })

  it('enumerates files when getPathForFile returns empty string', async () => {
    const nestedFile = new File(['content'], 'nested.txt')
    const dirEntry = createMockDirEntry('my-folder', [
      createMockFileEntry('nested.txt', nestedFile) as unknown as FileSystemEntry,
    ])

    window.electronAPI = {
      getPathForFile: vi.fn(() => ''),
    } as any

    const mockDataTransfer = {
      items: [{ webkitGetAsEntry: () => dirEntry }],
      files: [new File([], 'my-folder')],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)

    expect(result.folders[0].folderPath).toBeUndefined()
    expect(result.folders[0].files).toHaveLength(1)
  })

  it('handles mixed files and folders in drag-and-drop', async () => {
    const regularFile = new File(['hello'], 'readme.md')
    const fileEntry = createMockFileEntry('readme.md', regularFile)

    const dirEntry = createMockDirEntry('src', [])

    const folderFile = new File([], 'src')

    window.electronAPI = {
      getPathForFile: vi.fn((f: File) => {
        if (f.name === 'src') return '/Users/joe/project/src'
        return ''
      }),
    } as any

    const mockDataTransfer = {
      items: [
        { webkitGetAsEntry: () => fileEntry },
        { webkitGetAsEntry: () => dirEntry },
      ],
      files: [regularFile, folderFile],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)

    expect(result.files).toHaveLength(1)
    expect(result.files[0].file).toBe(regularFile)
    expect(result.folders).toHaveLength(1)
    expect(result.folders[0].folderPath).toBe('/Users/joe/project/src')
  })
})

// ============================================================================
// zipFolderFiles — browser zip fallback
// ============================================================================

describe('zipFolderFiles', () => {
  it('creates a valid zip blob from files', async () => {
    const files = [
      { file: new File(['hello'], 'a.txt'), relativePath: 'folder/a.txt' },
      { file: new File(['world'], 'b.txt'), relativePath: 'folder/b.txt' },
    ]

    const blob = await zipFolderFiles(files)

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/zip')
    expect(blob.size).toBeGreaterThan(0)
  })

  it('handles empty file list', async () => {
    const blob = await zipFolderFiles([])

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/zip')
  })

  it('handles single file', async () => {
    const files = [
      { file: new File(['content'], 'test.txt'), relativePath: 'folder/test.txt' },
    ]

    const blob = await zipFolderFiles(files)
    expect(blob.size).toBeGreaterThan(0)
  })
})
