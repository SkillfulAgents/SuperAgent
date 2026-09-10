import crypto from 'crypto'

/**
 * Where the database file lives, coarsely — enough to diagnose "SQLite cannot
 * lock this file" without ever recording a user path.
 *
 * SQLite's locking is unreliable on SMB/NFS shares (advisory locks are not
 * honoured across clients), which shows up as unexplained SQLITE_BUSY /
 * SQLITE_IOERR / SQLITE_PROTOCOL at startup. Users hit this by pointing
 * SUPERAGENT_DB_PATH at a network drive or by syncing their data dir.
 */
export type DatabaseFilesystemClass = 'local' | 'network-share' | 'unknown'

/** UNC (\\server\share, //server/share) is definitively a network share. */
export function classifyDatabaseFilesystem(dbPath: string): DatabaseFilesystemClass {
  if (/^(\\\\|\/\/)[^\\/]/.test(dbPath)) return 'network-share'
  return 'local'
}

/** Opaque, stable identity for a database file — never the path itself. */
export function databaseIdentity(dbPath: string): string {
  return crypto.createHash('sha256').update(dbPath).digest('hex').slice(0, 12)
}

const LOCKING_ERROR_CODES = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_PROTOCOL',
  'SQLITE_READONLY',
]

/** SQLite's own error code, when the driver provides one. */
export function sqliteErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('SQLITE') ? code : null
}

export function isLockingError(error: unknown): boolean {
  const code = sqliteErrorCode(error)
  if (code && LOCKING_ERROR_CODES.some((c) => code.startsWith(c))) return true
  return /database is locked|database table is locked/i.test(
    error instanceof Error ? error.message : String(error)
  )
}

/**
 * Turn an unexplained locking failure on a network share into an actionable
 * message instead of a bare SQLITE_BUSY. Returns null when the failure is not
 * attributable to the filesystem.
 */
export function describeUnsupportedFilesystem(
  filesystem: DatabaseFilesystemClass,
  error: unknown
): string | null {
  if (filesystem !== 'network-share' || !isLockingError(error)) return null
  return (
    'The database is stored on a network share, where SQLite cannot lock the file reliably. ' +
    'Move the data directory to a local disk (or set SUPERAGENT_DB_PATH to a local path) and restart.'
  )
}
