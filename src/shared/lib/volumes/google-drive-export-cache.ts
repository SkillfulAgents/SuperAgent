import pLimit from 'p-limit'
import type { DriveFile } from './google-drive-schema'

/** An export's bytes, or that Drive refused it as over 10 MB. */
export type Export = Uint8Array<ArrayBuffer> | 'too-large'
export type ExportSize = number | 'too-large'

const PARALLEL_EXPORTS = 8
const MAX_EXPORTS = 8_000
const MAX_BYTES = 100 * 1024 * 1024
const keyOf = (accountId: string, file: DriveFile) => JSON.stringify([accountId, file.id, file.modifiedTime])

/** Exports by account, file and version, oldest dropped first past 100 MB. Drive's xlsx and pptx
 * exports differ from one export to the next, sometimes in size, so a read serves the bytes
 * its listing was sized from. */
export class GoogleDriveExportCache {
  private readonly exports = new Map<string, Export>()
  private bytes = 0

  size(accountId: string, file: DriveFile): ExportSize | undefined {
    const held = this.exports.get(keyOf(accountId, file))
    return held instanceof Uint8Array ? held.length : held
  }

  tooLarge(accountId: string, file: DriveFile): boolean {
    return this.size(accountId, file) === 'too-large'
  }

  private drop(key: string): void {
    const held = this.exports.get(key)
    if (held instanceof Uint8Array) this.bytes -= held.length
    this.exports.delete(key)
  }

  /** The export of `file`, run now unless held. */
  async exported(accountId: string, file: DriveFile, exporter: () => Promise<Export>): Promise<Export> {
    const key = keyOf(accountId, file)
    const held = this.exports.get(key)
    if (held !== undefined) return held
    const exported = await exporter()
    this.drop(key)
    this.exports.set(key, exported)
    if (exported instanceof Uint8Array) this.bytes += exported.length
    while (this.exports.size > MAX_EXPORTS || this.bytes > MAX_BYTES) this.drop(this.exports.keys().next().value!)
    return exported
  }

  /** Export what `items` lack, at most eight at a time. A failed export fails the call
   * once the rest have settled, keeping every export made. */
  async learn<T extends { file: DriveFile }>(accountId: string, items: T[], exporter: (item: T) => Promise<Export>): Promise<void> {
    const limit = pLimit(PARALLEL_EXPORTS)
    const results = await Promise.allSettled(items.filter(item => !this.exports.has(keyOf(accountId, item.file)))
      .map(item => limit(() => this.exported(accountId, item.file, () => exporter(item)))))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}

export const googleDriveExportCache = new GoogleDriveExportCache()
