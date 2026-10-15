import pLimit from 'p-limit'
import type { DriveFile } from './google-drive-schema'

export type Export = Uint8Array<ArrayBuffer> | 'too-large'
export type ExportSize = number | 'too-large'
const PARALLEL_EXPORTS = 16
const MAX_EXPORTS = 8_000
const MAX_BYTES = 100 * 1024 * 1024
const keyOf = (accountId: string, file: DriveFile) => JSON.stringify([accountId, file.id, file.version ?? file.modifiedTime])

/** Byte eviction must not erase listing metadata. Each learn() also returns its
 * own size snapshot, so even a listing exceeding both cache limits can complete.
 * Identical exports in flight are coalesced and share one concurrency limit. */
export class GoogleDriveExportCache {
  private readonly exports = new Map<string, Export>()
  private readonly sizes = new Map<string, ExportSize>()
  private readonly pending = new Map<string, Promise<Export>>()
  private readonly limit = pLimit(PARALLEL_EXPORTS)
  private bytes = 0

  size(accountId: string, file: DriveFile): ExportSize | undefined { return this.sizes.get(keyOf(accountId, file)) }
  tooLarge(accountId: string, file: DriveFile): boolean { return this.size(accountId, file) === 'too-large' }

  private drop(key: string): void {
    const held = this.exports.get(key)
    if (held instanceof Uint8Array) this.bytes -= held.length
    this.exports.delete(key)
  }

  async exported(accountId: string, file: DriveFile, exporter: () => Promise<Export>): Promise<Export> {
    const key = keyOf(accountId, file)
    const held = this.exports.get(key)
    if (held !== undefined) return held
    if (this.sizes.get(key) === 'too-large') return 'too-large'
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = this.limit(exporter).then(exported => {
      this.drop(key)
      this.exports.set(key, exported)
      this.sizes.delete(key)
      this.sizes.set(key, exported instanceof Uint8Array ? exported.length : exported)
      if (exported instanceof Uint8Array) this.bytes += exported.length
      while (this.exports.size > MAX_EXPORTS || this.bytes > MAX_BYTES) this.drop(this.exports.keys().next().value!)
      while (this.sizes.size > MAX_EXPORTS) this.sizes.delete(this.sizes.keys().next().value!)
      return exported
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }

  async learn<T extends { file: DriveFile }>(accountId: string, items: T[], exporter: (item: T) => Promise<Export>): Promise<Map<DriveFile, ExportSize>> {
    const sizes = new Map<DriveFile, ExportSize>()
    const results = await Promise.allSettled(items.map(async item => {
      let size = this.size(accountId, item.file)
      if (size === undefined) {
        const exported = await this.exported(accountId, item.file, () => exporter(item))
        size = exported instanceof Uint8Array ? exported.length : exported
      }
      sizes.set(item.file, size)
    }))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    return sizes
  }
}

export const googleDriveExportCache = new GoogleDriveExportCache()
