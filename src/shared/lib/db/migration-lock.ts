import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * Synchronous inter-process lock for database startup (open + migrate).
 *
 * Why sync: the database is initialised lazily and synchronously (see
 * `db/index.ts` — the exported `db`/`sqlite` proxies call `initDb()` on first
 * property access), so the lock has to hold across a sync critical section.
 * The async `withCrossProcessFileLock` in `utils/file-storage.ts` cannot be
 * used here. Blocking is correct at this point: nothing in the process can do
 * useful work until the schema exists.
 *
 * Why a lock at all: drizzle's better-sqlite3 migrator reads "last applied
 * migration" BEFORE opening its transaction, then applies every newer
 * migration inside it. Two processes starting together therefore both decide
 * to apply the same migrations; the loser either fails outright with
 * "database is locked" (no busy timeout) or — once a busy timeout makes it
 * wait — wakes up after the winner commits and replays already-applied DDL,
 * producing "duplicate column name". A busy timeout alone converts one
 * failure into the other; serialising the whole read-decide-apply sequence is
 * what actually fixes it.
 */

export interface MigrationLockOptions {
  /** Max time to wait for the lock before throwing (ms). */
  timeoutMs?: number
  /** Poll interval while another process holds the lock (ms). */
  retryIntervalMs?: number
  /** A lock file older than this is treated as abandoned and stolen (ms). */
  staleMs?: number
}

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_INTERVAL_MS = 50
const DEFAULT_STALE_MS = 60_000

/** Blocking sleep — safe here, and the only option in a sync critical section. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

export class MigrationLockTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`Timed out after ${waitedMs}ms waiting for the database migration lock`)
    this.name = 'MigrationLockTimeoutError'
  }
}

export interface MigrationLockOutcome {
  /** Whether an abandoned lock from a dead process had to be stolen. */
  stoleStaleLock: boolean
  /** How long acquisition blocked, for telemetry. */
  waitedMs: number
}

/**
 * Run `fn` while holding `<dbPath>.migrate.lock`.
 *
 * The lock file is created with O_EXCL and carries an owner token, so release
 * only removes a lock we still own. A lock whose file is older than `staleMs`
 * is assumed to belong to a process that died mid-migration and is stolen —
 * otherwise one crash would wedge every future start.
 */
export function withMigrationLock<T>(
  dbPath: string,
  fn: (outcome: MigrationLockOutcome) => T,
  options?: MigrationLockOptions
): T {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS
  const retryIntervalMs = options?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS
  const lockPath = `${dbPath}.migrate.lock`
  const ownerToken = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let stoleStaleLock = false
  let acquiredAt = 0

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, ownerToken)
      } finally {
        fs.closeSync(fd)
      }
      acquiredAt = Date.now()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > staleMs) {
          // The holder died mid-migration (or the machine lost power). Steal
          // rather than let one crash wedge every future start.
          fs.rmSync(lockPath, { force: true })
          stoleStaleLock = true
          continue
        }
      } catch {
        continue // vanished between open and stat — try again immediately
      }
      if (Date.now() >= deadline) {
        throw new MigrationLockTimeoutError(Date.now() - startedAt)
      }
      sleepSync(retryIntervalMs)
    }
  }

  try {
    return fn({ stoleStaleLock, waitedMs: acquiredAt - startedAt })
  } finally {
    // Release only if the file still holds OUR token: a later starter may have
    // stolen it as stale while we ran, and deleting theirs would let a third
    // process in while they are mid-migration.
    let current: string | null = null
    try {
      current = fs.readFileSync(lockPath, 'utf-8')
    } catch {
      current = null
    }
    if (current === ownerToken || (current === null && Date.now() - acquiredAt < staleMs)) {
      try {
        fs.rmSync(lockPath, { force: true })
      } catch {
        // Best effort: a leaked lock ages into staleness and is stolen.
      }
    }
  }
}
