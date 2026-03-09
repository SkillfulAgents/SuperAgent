// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  getFolderFromDirectoryInput,
  getItemsFromDataTransfer,
} from './file-utils'

/**
 * Helper to create a mock FileList from an array of partial File objects.
 */
function createMockFileList(
  files: Array<{ name: string; webkitRelativePath?: string }>
): FileList {
  const fileObjects = files.map((f) => {
    const file = new File([''], f.name)
    Object.defineProperty(file, 'webkitRelativePath', {
      value: f.webkitRelativePath ?? '',
      writable: false,
    })
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

describe('getFolderFromDirectoryInput', () => {
  it('returns null for an empty FileList', () => {
    const fileList = createMockFileList([])
    expect(getFolderFromDirectoryInput(fileList)).toBeNull()
  })

  it('extracts folder name from first file webkitRelativePath', () => {
    const fileList = createMockFileList([
      { name: 'index.ts', webkitRelativePath: 'my-project/index.ts' },
      { name: 'utils.ts', webkitRelativePath: 'my-project/lib/utils.ts' },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.folderName).toBe('my-project')
  })

  it('falls back to "folder" when webkitRelativePath is empty', () => {
    const fileList = createMockFileList([
      { name: 'file.txt', webkitRelativePath: '' },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.folderName).toBe('folder')
  })

  it('includes all files with their relative paths', () => {
    const fileList = createMockFileList([
      { name: 'a.ts', webkitRelativePath: 'src/a.ts' },
      { name: 'b.ts', webkitRelativePath: 'src/lib/b.ts' },
      { name: 'c.ts', webkitRelativePath: 'src/lib/c.ts' },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.files).toHaveLength(3)
    expect(result!.files[0].relativePath).toBe('src/a.ts')
    expect(result!.files[1].relativePath).toBe('src/lib/b.ts')
    expect(result!.files[2].relativePath).toBe('src/lib/c.ts')
  })

  it('uses file.name as fallback when webkitRelativePath is empty', () => {
    const fileList = createMockFileList([
      { name: 'standalone.txt', webkitRelativePath: '' },
    ])

    const result = getFolderFromDirectoryInput(fileList)
    expect(result).not.toBeNull()
    expect(result!.files[0].relativePath).toBe('standalone.txt')
  })
})

describe('getItemsFromDataTransfer', () => {
  it('falls back to dataTransfer.files when no webkitGetAsEntry support', async () => {
    const file1 = new File(['hello'], 'hello.txt')
    const file2 = new File(['world'], 'world.txt')

    const mockDataTransfer = {
      items: [
        { webkitGetAsEntry: undefined },
        { webkitGetAsEntry: () => null },
      ],
      files: [file1, file2],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)
    expect(result.files).toHaveLength(2)
    expect(result.files[0].file).toBe(file1)
    expect(result.files[1].file).toBe(file2)
    expect(result.folders).toHaveLength(0)
  })

  it('separates files and folders from entries', async () => {
    const regularFile = new File(['content'], 'readme.md')

    const fileEntry: Partial<FileSystemFileEntry> = {
      isFile: true,
      isDirectory: false,
      name: 'readme.md',
      file: (successCb: FileCallback) => successCb(regularFile),
    }

    const nestedFile = new File(['nested'], 'nested.txt')
    const dirEntry: Partial<FileSystemDirectoryEntry> = {
      isFile: false,
      isDirectory: true,
      name: 'my-folder',
      createReader: () =>
        ({
          readEntries: (() => {
            let called = false
            return (
              successCb: (entries: FileSystemEntry[]) => void
            ) => {
              if (!called) {
                called = true
                successCb([
                  {
                    isFile: true,
                    isDirectory: false,
                    name: 'nested.txt',
                    file: (cb: FileCallback) => cb(nestedFile),
                  } as unknown as FileSystemEntry,
                ])
              } else {
                successCb([])
              }
            }
          })(),
        }) as unknown as FileSystemDirectoryReader,
    }

    const mockDataTransfer = {
      items: [
        { webkitGetAsEntry: () => fileEntry },
        { webkitGetAsEntry: () => dirEntry },
      ],
      files: [],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)

    expect(result.files).toHaveLength(1)
    expect(result.files[0].file).toBe(regularFile)

    expect(result.folders).toHaveLength(1)
    expect(result.folders[0].folderName).toBe('my-folder')
    expect(result.folders[0].files).toHaveLength(1)
    expect(result.folders[0].files[0].file).toBe(nestedFile)
    expect(result.folders[0].files[0].relativePath).toBe(
      'my-folder/nested.txt'
    )
  })

  it('recursively reads nested directory contents', async () => {
    const deepFile = new File(['deep'], 'deep.txt')

    const innerDirEntry: Partial<FileSystemDirectoryEntry> = {
      isFile: false,
      isDirectory: true,
      name: 'inner',
      createReader: () =>
        ({
          readEntries: (() => {
            let called = false
            return (
              successCb: (entries: FileSystemEntry[]) => void
            ) => {
              if (!called) {
                called = true
                successCb([
                  {
                    isFile: true,
                    isDirectory: false,
                    name: 'deep.txt',
                    file: (cb: FileCallback) => cb(deepFile),
                  } as unknown as FileSystemEntry,
                ])
              } else {
                successCb([])
              }
            }
          })(),
        }) as unknown as FileSystemDirectoryReader,
    }

    const outerDirEntry: Partial<FileSystemDirectoryEntry> = {
      isFile: false,
      isDirectory: true,
      name: 'outer',
      createReader: () =>
        ({
          readEntries: (() => {
            let called = false
            return (
              successCb: (entries: FileSystemEntry[]) => void
            ) => {
              if (!called) {
                called = true
                successCb([innerDirEntry as unknown as FileSystemEntry])
              } else {
                successCb([])
              }
            }
          })(),
        }) as unknown as FileSystemDirectoryReader,
    }

    const mockDataTransfer = {
      items: [{ webkitGetAsEntry: () => outerDirEntry }],
      files: [],
    } as unknown as DataTransfer

    const result = await getItemsFromDataTransfer(mockDataTransfer)

    expect(result.files).toHaveLength(0)
    expect(result.folders).toHaveLength(1)
    expect(result.folders[0].folderName).toBe('outer')
    expect(result.folders[0].files).toHaveLength(1)
    expect(result.folders[0].files[0].file).toBe(deepFile)
    expect(result.folders[0].files[0].relativePath).toBe(
      'outer/inner/deep.txt'
    )
  })
})
