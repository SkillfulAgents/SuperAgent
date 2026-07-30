import * as fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { ensureDirectory, getTempUploadsDir, removeDirectory } from './file-storage'

// Workspace chat/file uploads. Streaming assembly keeps RAM O(chunk); this caps disk.
export const MAX_UPLOAD_TOTAL_SIZE = 2 * 1024 * 1024 * 1024

// Throw from storeUploadChunk so routes can map to HTTP 413 without reading bytes.
export class UploadTooLargeError extends Error {
  readonly size: number
  readonly maxBytes: number

  constructor(size: number, maxBytes: number) {
    super(`File too large (${(size / 1024 / 1024).toFixed(1)}MB, max ${maxBytes / 1024 / 1024}MB)`)
    this.name = 'UploadTooLargeError'
    this.size = size
    this.maxBytes = maxBytes
  }
}

export type StoreChunkResult =
  | { status: 'received' }
  | { status: 'assembled'; filePath: string }

async function sumChunkBytes(uploadDir: string, chunkIndexToReplace?: number): Promise<{ total: number; replaced: number }> {
  let total = 0
  let replaced = 0
  let entries: string[]
  try {
    entries = await fs.promises.readdir(uploadDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { total: 0, replaced: 0 }
    throw err
  }
  for (const name of entries) {
    if (!name.startsWith('chunk-')) continue
    const size = (await fs.promises.stat(path.join(uploadDir, name))).size
    total += size
    if (chunkIndexToReplace !== undefined && name === `chunk-${chunkIndexToReplace}`) {
      replaced = size
    }
  }
  return { total, replaced }
}

// Persist one chunk; stream-assemble to a temp file once all arrive.
// Caller owns deleting the assembled filePath after consuming it.
export async function storeUploadChunk(
  uploadId: string,
  chunkIndex: number,
  totalChunks: number,
  chunk: Buffer,
  maxTotalBytes?: number,
): Promise<StoreChunkResult> {
  const uploadDir = path.join(getTempUploadsDir(), uploadId)
  await ensureDirectory(uploadDir)

  if (maxTotalBytes !== undefined) {
    const { total, replaced } = await sumChunkBytes(uploadDir, chunkIndex)
    const projected = total - replaced + chunk.byteLength
    if (projected > maxTotalBytes) {
      try { await removeDirectory(uploadDir) } catch { /* ignore cleanup errors */ }
      throw new UploadTooLargeError(projected, maxTotalBytes)
    }
  }

  await fs.promises.writeFile(path.join(uploadDir, `chunk-${chunkIndex}`), chunk)

  const files = await fs.promises.readdir(uploadDir)
  const chunkFiles = files.filter((f) => f.startsWith('chunk-'))
  if (chunkFiles.length < totalChunks) {
    return { status: 'received' }
  }

  const lockPath = path.join(uploadDir, '.assembling')
  try {
    await fs.promises.writeFile(lockPath, '', { flag: 'wx' })
  } catch {
    return { status: 'received' }
  }

  const assembledPath = path.join(getTempUploadsDir(), `${uploadId}.assembled`)
  try {
    for (let i = 0; i < totalChunks; i++) {
      await pipeline(
        fs.createReadStream(path.join(uploadDir, `chunk-${i}`)),
        fs.createWriteStream(assembledPath, { flags: i === 0 ? 'w' : 'a' }),
      )
    }
    return { status: 'assembled', filePath: assembledPath }
  } catch (err) {
    try { await fs.promises.unlink(assembledPath) } catch { /* ignore */ }
    throw err
  } finally {
    try { await removeDirectory(uploadDir) } catch { /* ignore cleanup errors */ }
  }
}

// Move an assembled temp file into dest; stream-copy on cross-device rename failure.
export async function moveUploadedFile(srcPath: string, destPath: string): Promise<number> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
  try {
    await fs.promises.rename(srcPath, destPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await pipeline(fs.createReadStream(srcPath), fs.createWriteStream(destPath))
    try { await fs.promises.unlink(srcPath) } catch { /* ignore */ }
  }
  return (await fs.promises.stat(destPath)).size
}

// Remove stale chunk dirs and orphaned `.assembled` files (crash between assemble and consume).
export async function cleanupStaleTempUploads(maxAgeMs: number, nowMs: number = Date.now()): Promise<void> {
  const uploadsDir = getTempUploadsDir()
  const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entryPath = path.join(uploadsDir, entry.name)
    const stat = await fs.promises.stat(entryPath).catch(() => null)
    if (!stat || nowMs - stat.mtimeMs <= maxAgeMs) continue
    if (entry.isDirectory()) {
      await removeDirectory(entryPath).catch(() => {})
    } else {
      await fs.promises.unlink(entryPath).catch(() => {})
    }
  }
}
