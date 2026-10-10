import type { VolumeEntry } from './base-mountable-volume'

const TTL_MS = 60_000
const FAILURE_TTL_MS = 5_000
const MAX_ENTRIES = 256
type Check = { accountId: string; expiresAt: number; result: Promise<VolumeEntry> }

/** UI health is advisory. Filesystem operations bypass this cache, and callers
 * must still authorize the account before reading it. Reconnects change the key. */
export class DropboxHealthCache {
  private readonly checks = new Map<string, Check>()

  invalidate(accountId: string): void {
    for (const [key, check] of this.checks) if (check.accountId === accountId) this.checks.delete(key)
  }

  check(accountId: string, path: string, accountVersion: number, read: () => Promise<VolumeEntry>): Promise<VolumeEntry> {
    const key = JSON.stringify([accountId, path.toLowerCase(), accountVersion])
    const cached = this.checks.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.result
    const check: Check = { accountId, expiresAt: Infinity, result: Promise.resolve().then(read).then(
      entry => { check.expiresAt = Date.now() + TTL_MS; return entry },
      error => { check.expiresAt = Date.now() + FAILURE_TTL_MS; throw error },
    ) }
    this.checks.delete(key)
    this.checks.set(key, check)
    while (this.checks.size > MAX_ENTRIES) this.checks.delete(this.checks.keys().next().value!)
    return check.result
  }
}

export const dropboxHealthCache = new DropboxHealthCache()
