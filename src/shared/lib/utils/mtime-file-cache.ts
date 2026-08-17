import * as fs from 'fs'
import * as path from 'path'

type Slot<T> = {
  mtimeMs: number
  size: number
  value: T
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

// Serve a parsed file when stat mtime+size still match. No TTL.
// Missing files are not stored, so a later create is visible on the next stat.
export class MtimeFileCache<T> {
  private readonly slots = new Map<string, Slot<T>>()
  private readonly inflight = new Map<string, Promise<T | undefined>>()

  constructor(private readonly clone: (value: T) => T) {}

  async get(filePath: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const key = path.resolve(filePath)
    const existing = this.inflight.get(key)
    if (existing) {
      const value = await existing
      return value === undefined ? undefined : this.clone(value)
    }

    const pending = this.load(key, load).finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key)
    })
    this.inflight.set(key, pending)
    const value = await pending
    return value === undefined ? undefined : this.clone(value)
  }

  clear(): void {
    this.slots.clear()
    this.inflight.clear()
  }

  private async load(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    let st: fs.Stats
    try {
      st = await fs.promises.stat(key)
    } catch (error) {
      if (isEnoent(error)) return undefined
      throw error
    }

    // mtimeMs === 0 is unusable as a generation (S3 Files birthtime is epoch;
    // skip caching rather than treat 0 as a stable key).
    if (st.mtimeMs !== 0) {
      const hit = this.slots.get(key)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        return hit.value
      }
    }

    const value = await load()
    if (value !== undefined && st.mtimeMs !== 0) {
      this.slots.set(key, { mtimeMs: st.mtimeMs, size: st.size, value })
    }
    return value
  }
}
