import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  openZipFromBuffer,
  createZipBuffer,
  writeZipFile,
  detectZipPrefix,
  ZipExtractionSizeError,
} from './zip'
import type { ZipEntryMeta } from './zip'

let tempDir: string

function makeTempDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'))
  return tempDir
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined!
  }
})

// ============================================================================
// createZipBuffer + openZipFromBuffer (round-trip)
// ============================================================================

describe('createZipBuffer + openZipFromBuffer', () => {
  it('round-trips files through write and read', async () => {
    const buf = await createZipBuffer({
      'hello.txt': 'hello world',
      'nested/deep/file.md': '# Title',
    })

    const reader = await openZipFromBuffer(buf)
    try {
      const fileEntries = reader.entries.filter((e) => !e.isDirectory)
      const fileNames = fileEntries.map((e) => e.fileName).sort()
      expect(fileNames).toEqual(['hello.txt', 'nested/deep/file.md'])

      const content = await reader.readEntry('hello.txt')
      expect(content.toString('utf-8')).toBe('hello world')

      const mdContent = await reader.readEntry('nested/deep/file.md')
      expect(mdContent.toString('utf-8')).toBe('# Title')
    } finally {
      reader.close()
    }
  })

  it('handles Buffer values', async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff])
    const buf = await createZipBuffer({ 'binary.bin': data })

    const reader = await openZipFromBuffer(buf)
    try {
      const content = await reader.readEntry('binary.bin')
      expect(content).toEqual(data)
    } finally {
      reader.close()
    }
  })

  it('reports correct uncompressed sizes', async () => {
    const content = 'x'.repeat(1000)
    const buf = await createZipBuffer({ 'file.txt': content })

    const reader = await openZipFromBuffer(buf)
    try {
      const entry = reader.entries.find((e) => e.fileName === 'file.txt')!
      expect(entry.uncompressedSize).toBe(1000)
      expect(entry.compressedSize).toBeLessThanOrEqual(1000)
    } finally {
      reader.close()
    }
  })

  it('marks directory entries correctly', async () => {
    const buf = await createZipBuffer({
      'dir/file.txt': 'content',
    })

    const reader = await openZipFromBuffer(buf)
    try {
      const dirs = reader.entries.filter((e) => e.isDirectory)
      const files = reader.entries.filter((e) => !e.isDirectory)
      expect(files.length).toBeGreaterThanOrEqual(1)
      for (const d of dirs) {
        expect(d.fileName.endsWith('/')).toBe(true)
      }
    } finally {
      reader.close()
    }
  })
})

// ============================================================================
// openZipFromBuffer — errors
// ============================================================================

describe('openZipFromBuffer — errors', () => {
  it('rejects with invalid buffer', async () => {
    await expect(openZipFromBuffer(Buffer.from('not a zip'))).rejects.toThrow()
  })

  it('rejects with empty buffer', async () => {
    await expect(openZipFromBuffer(Buffer.alloc(0))).rejects.toThrow()
  })
})

// ============================================================================
// readEntry
// ============================================================================

describe('readEntry', () => {
  it('throws for nonexistent entry', async () => {
    const buf = await createZipBuffer({ 'a.txt': 'content' })
    const reader = await openZipFromBuffer(buf)
    try {
      await expect(reader.readEntry('nonexistent.txt')).rejects.toThrow('Entry not found')
    } finally {
      reader.close()
    }
  })

  it('throws ZipExtractionSizeError when maxBytes exceeded', async () => {
    const content = 'x'.repeat(1000)
    const buf = await createZipBuffer({ 'big.txt': content })
    const reader = await openZipFromBuffer(buf)
    try {
      await expect(reader.readEntry('big.txt', 500)).rejects.toThrow(ZipExtractionSizeError)
    } finally {
      reader.close()
    }
  })

  it('succeeds when content fits within maxBytes', async () => {
    const content = 'hello'
    const buf = await createZipBuffer({ 'small.txt': content })
    const reader = await openZipFromBuffer(buf)
    try {
      const data = await reader.readEntry('small.txt', 1000)
      expect(data.toString('utf-8')).toBe('hello')
    } finally {
      reader.close()
    }
  })
})

// ============================================================================
// extractEntry
// ============================================================================

describe('extractEntry', () => {
  it('extracts file to disk', async () => {
    const dir = makeTempDir()
    const buf = await createZipBuffer({ 'test.txt': 'file content here' })
    const reader = await openZipFromBuffer(buf)
    try {
      const destPath = path.join(dir, 'test.txt')
      const bytes = await reader.extractEntry('test.txt', destPath)
      expect(bytes).toBe(17)
      expect(fs.readFileSync(destPath, 'utf-8')).toBe('file content here')
    } finally {
      reader.close()
    }
  })

  it('returns actual byte count', async () => {
    const dir = makeTempDir()
    const content = 'a'.repeat(5000)
    const buf = await createZipBuffer({ 'data.bin': content })
    const reader = await openZipFromBuffer(buf)
    try {
      const bytes = await reader.extractEntry('data.bin', path.join(dir, 'data.bin'))
      expect(bytes).toBe(5000)
    } finally {
      reader.close()
    }
  })

  it('throws ZipExtractionSizeError and cleans up partial file when maxBytes exceeded', async () => {
    const dir = makeTempDir()
    const content = 'x'.repeat(10000)
    const buf = await createZipBuffer({ 'large.bin': content })
    const reader = await openZipFromBuffer(buf)
    try {
      const destPath = path.join(dir, 'large.bin')
      await expect(reader.extractEntry('large.bin', destPath, 500)).rejects.toThrow(ZipExtractionSizeError)
      // Partial file cleanup is deferred to writeStream close; allow time for it
      await new Promise((r) => setTimeout(r, 100))
      expect(fs.existsSync(destPath)).toBe(false)
    } finally {
      reader.close()
    }
  })

  it('throws for nonexistent entry', async () => {
    const buf = await createZipBuffer({ 'a.txt': 'content' })
    const reader = await openZipFromBuffer(buf)
    try {
      await expect(reader.extractEntry('nope.txt', '/tmp/nope')).rejects.toThrow('Entry not found')
    } finally {
      reader.close()
    }
  })
})

// ============================================================================
// writeZipFile
// ============================================================================

describe('writeZipFile', () => {
  it('writes a valid ZIP to disk', async () => {
    const dir = makeTempDir()
    const zipPath = path.join(dir, 'output.zip')
    await writeZipFile(zipPath, {
      'README.md': '# Hello',
      'src/index.ts': 'export {}',
    })

    expect(fs.existsSync(zipPath)).toBe(true)

    const reader = await openZipFromBuffer(fs.readFileSync(zipPath))
    try {
      const names = reader.entries.filter((e) => !e.isDirectory).map((e) => e.fileName).sort()
      expect(names).toEqual(['README.md', 'src/index.ts'])
    } finally {
      reader.close()
    }
  })
})

// ============================================================================
// detectZipPrefix
// ============================================================================

describe('detectZipPrefix', () => {
  it('detects common prefix when all files share one', () => {
    const entries: ZipEntryMeta[] = [
      { fileName: 'wrapper/', isDirectory: true, uncompressedSize: 0, compressedSize: 0 },
      { fileName: 'wrapper/file1.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
      { fileName: 'wrapper/sub/file2.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
    ]
    expect(detectZipPrefix(entries)).toBe('wrapper/')
  })

  it('returns empty string when files are at root level', () => {
    const entries: ZipEntryMeta[] = [
      { fileName: 'file1.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
      { fileName: 'file2.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
    ]
    expect(detectZipPrefix(entries)).toBe('')
  })

  it('returns empty string when files have different top-level dirs', () => {
    const entries: ZipEntryMeta[] = [
      { fileName: 'dir1/file.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
      { fileName: 'dir2/file.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
    ]
    expect(detectZipPrefix(entries)).toBe('')
  })

  it('ignores __MACOSX entries', () => {
    const entries: ZipEntryMeta[] = [
      { fileName: '__MACOSX/._file', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
      { fileName: 'wrapper/file.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
    ]
    expect(detectZipPrefix(entries)).toBe('wrapper/')
  })

  it('returns empty string for empty entries', () => {
    expect(detectZipPrefix([])).toBe('')
  })

  it('returns empty string when only directory entries exist', () => {
    const entries: ZipEntryMeta[] = [
      { fileName: 'dir/', isDirectory: true, uncompressedSize: 0, compressedSize: 0 },
    ]
    expect(detectZipPrefix(entries)).toBe('')
  })

  it('handles single file in a directory as common prefix', () => {
    const entries: ZipEntryMeta[] = [
      { fileName: 'only-dir/only-file.txt', isDirectory: false, uncompressedSize: 10, compressedSize: 5 },
    ]
    expect(detectZipPrefix(entries)).toBe('only-dir/')
  })
})
