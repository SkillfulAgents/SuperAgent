import fs from 'fs'
import { PassThrough, type Readable } from 'stream'
import yauzl from 'yauzl'
import yazl from 'yazl'

// ============================================================================
// Types
// ============================================================================

export interface ZipEntryMeta {
  fileName: string
  uncompressedSize: number
  compressedSize: number
  isDirectory: boolean
}

export interface ZipReader {
  readonly entries: ZipEntryMeta[]
  readEntry(fileName: string, maxBytes?: number): Promise<Buffer>
  extractEntry(fileName: string, destPath: string, maxBytes?: number): Promise<number>
  close(): void
}

// ============================================================================
// Errors
// ============================================================================

export class ZipExtractionSizeError extends Error {
  constructor(
    public readonly limit: number,
    public readonly actual: number,
  ) {
    super(`Extracted size (${actual} bytes) exceeds limit (${limit} bytes)`)
    this.name = 'ZipExtractionSizeError'
  }
}

// ============================================================================
// Reading (yauzl)
// ============================================================================

export async function openZipFromBuffer(buffer: Buffer): Promise<ZipReader> {
  const { zipFile, entries: entryMetas, rawEntries } = await openAndCollectEntries(buffer)
  let closed = false

  return {
    entries: entryMetas,

    async readEntry(fileName: string, maxBytes?: number): Promise<Buffer> {
      if (closed) throw new Error('ZipReader has been closed')
      const rawEntry = rawEntries.get(fileName)
      if (!rawEntry) {
        throw new Error(`Entry not found in ZIP: ${fileName}`)
      }

      const readStream = await openReadStream(zipFile, rawEntry)
      const chunks: Buffer[] = []
      let totalBytes = 0
      let settled = false

      return new Promise<Buffer>((resolve, reject) => {
        readStream.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (maxBytes !== undefined && totalBytes > maxBytes) {
            settled = true
            readStream.destroy()
            reject(new ZipExtractionSizeError(maxBytes, totalBytes))
            return
          }
          chunks.push(chunk)
        })
        readStream.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)) })
        readStream.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
      })
    },

    async extractEntry(fileName: string, destPath: string, maxBytes?: number): Promise<number> {
      if (closed) throw new Error('ZipReader has been closed')
      const rawEntry = rawEntries.get(fileName)
      if (!rawEntry) {
        throw new Error(`Entry not found in ZIP: ${fileName}`)
      }

      const readStream = await openReadStream(zipFile, rawEntry)
      const writeStream = fs.createWriteStream(destPath)
      let totalBytes = 0

      return new Promise<number>((resolve, reject) => {
        let errored = false
        const onError = (err: Error) => {
          if (errored) return
          errored = true
          readStream.destroy()
          writeStream.destroy()
          // Defer unlink until writeStream releases the file descriptor
          writeStream.once('close', () => fs.unlink(destPath, () => {}))
          reject(err)
        }

        readStream.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (maxBytes !== undefined && totalBytes > maxBytes) {
            onError(new ZipExtractionSizeError(maxBytes, totalBytes))
            return
          }
          if (!writeStream.write(chunk)) {
            readStream.pause()
            writeStream.once('drain', () => readStream.resume())
          }
        })

        readStream.on('error', onError)
        writeStream.on('error', onError)

        readStream.on('end', () => {
          writeStream.end(() => resolve(totalBytes))
        })
      })
    },

    close() {
      if (!closed) {
        closed = true
        zipFile.close()
      }
    },
  }
}

function openAndCollectEntries(buffer: Buffer): Promise<{
  zipFile: yauzl.ZipFile
  entries: ZipEntryMeta[]
  rawEntries: Map<string, yauzl.Entry>
}> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zipFile) => {
      if (err || !zipFile) {
        reject(err || new Error('Failed to open ZIP'))
        return
      }

      const entries: ZipEntryMeta[] = []
      const rawEntries = new Map<string, yauzl.Entry>()

      zipFile.on('entry', (entry: yauzl.Entry) => {
        const isDirectory = entry.fileName.endsWith('/')
        entries.push({
          fileName: entry.fileName,
          uncompressedSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          isDirectory,
        })
        if (!isDirectory) {
          rawEntries.set(entry.fileName, entry)
        }
        zipFile.readEntry()
      })

      zipFile.on('end', () => resolve({ zipFile, entries, rawEntries }))
      zipFile.on('error', reject)

      zipFile.readEntry()
    })
  })
}

function openReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err || new Error('Failed to open read stream'))
        return
      }
      resolve(stream as Readable)
    })
  })
}

// ============================================================================
// Writing (yazl)
// ============================================================================

export async function createZipBuffer(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zipFile = new yazl.ZipFile()

  for (const [filePath, content] of Object.entries(files)) {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
    zipFile.addBuffer(buf, filePath)
  }

  zipFile.end()

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const passThrough = new PassThrough()

    passThrough.on('data', (chunk: Buffer) => chunks.push(chunk))
    passThrough.on('end', () => resolve(Buffer.concat(chunks)))
    passThrough.on('error', reject)

    zipFile.outputStream.pipe(passThrough)
    zipFile.outputStream.on('error', reject)
  })
}

export async function writeZipFile(
  filePath: string,
  files: Record<string, Buffer | string>,
): Promise<void> {
  const zipFile = new yazl.ZipFile()

  for (const [entryPath, content] of Object.entries(files)) {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
    zipFile.addBuffer(buf, entryPath)
  }

  zipFile.end()

  return new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath)
    writeStream.on('finish', () => resolve())
    writeStream.on('error', reject)
    zipFile.outputStream.pipe(writeStream)
    zipFile.outputStream.on('error', reject)
  })
}

// ============================================================================
// Helpers
// ============================================================================

export function detectZipPrefix(entries: ZipEntryMeta[]): string {
  const fileEntries = entries.filter(
    (e) => !e.isDirectory && !e.fileName.startsWith('__MACOSX/')
  )

  if (fileEntries.length === 0) return ''

  const firstSegments = new Set<string>()
  for (const entry of fileEntries) {
    const slashIdx = entry.fileName.indexOf('/')
    if (slashIdx === -1) return ''
    firstSegments.add(entry.fileName.substring(0, slashIdx + 1))
  }

  return firstSegments.size === 1 ? firstSegments.values().next().value! : ''
}
