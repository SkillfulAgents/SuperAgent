import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * Narrow repair for a database whose SCHEMA is ahead of its migration journal.
 *
 * How that state is reached: drizzle's better-sqlite3 migrator reads "last
 * applied migration" before it opens its transaction, so two processes racing
 * a start can both decide to apply the same file. Once the loser stops failing
 * with "database is locked" (busy timeout) it replays already-applied DDL and
 * dies with `duplicate column name: <col>` — and any tool that applies
 * migrations outside the app (drizzle-kit) can leave the same divergence.
 *
 * The repair is deliberately narrow. A duplicate-column error is NEVER
 * blanket-ignored: the migration in question must consist solely of ADD COLUMN
 * statements, and every one of those columns must already exist with the exact
 * declared shape (name, type, NOT NULL, DEFAULT). Only then is the journal row
 * recorded so the migrator can move on. Anything else — a missing column, a
 * column whose type/nullability/default differs, a migration that also creates
 * tables or indexes — stays fatal, because the schema is genuinely not what
 * the migration describes.
 */

export interface JournalMigration {
  tag: string
  /** `when` from meta/_journal.json — drizzle's `created_at`/folderMillis. */
  when: number
  /** sha256 of the raw file, exactly as drizzle computes it. */
  hash: string
  statements: string[]
}

export interface AddColumnStatement {
  table: string
  column: string
  type: string
  notNull: boolean
  defaultValue: string | null
}

export type RepairOutcome =
  | { repaired: true; tag: string; columns: string[] }
  | { repaired: false; reason: string; tag?: string }

const MIGRATIONS_TABLE = '__drizzle_migrations'

/**
 * Flatten an error and its `cause` chain: drizzle wraps driver failures in
 * `Failed to run the query '<sql>'`, so the SQLite text we need to classify
 * ("duplicate column name: x") only appears on the cause.
 */
function messageChain(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return ''
  const message = error instanceof Error ? error.message : String(error)
  const cause = (error as { cause?: unknown })?.cause
  return cause === undefined ? message : `${message}\n${messageChain(cause, depth + 1)}`
}

export function isDuplicateColumnError(error: unknown): boolean {
  return /duplicate column name/i.test(messageChain(error))
}

export function extractDuplicateColumn(error: unknown): string | null {
  return messageChain(error).match(/duplicate column name:\s*"?([A-Za-z0-9_]+)"?/i)?.[1] ?? null
}

/** Read the journal exactly the way drizzle's migrator does. */
export function readJournalMigrations(migrationsFolder: string): JournalMigration[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
    entries: { when: number; tag: string }[]
  }
  return journal.entries.map((entry) => {
    const raw = fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf-8')
    return {
      tag: entry.tag,
      when: entry.when,
      hash: crypto.createHash('sha256').update(raw).digest('hex'),
      statements: raw
        .split('--> statement-breakpoint')
        .map((s) => s.trim().replace(/;\s*$/, '').trim())
        .filter(Boolean),
    }
  })
}

const ADD_COLUMN_RE =
  /^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+(?:COLUMN\s+)?`?([A-Za-z0-9_]+)`?\s*(.*)$/is

/**
 * Parse a migration as a pure ADD COLUMN migration.
 * Returns null if ANY statement is something else — such a migration is never
 * repaired here.
 */
export function parseAddColumnMigration(statements: string[]): AddColumnStatement[] | null {
  const parsed: AddColumnStatement[] = []
  for (const statement of statements) {
    const match = statement.match(ADD_COLUMN_RE)
    if (!match) return null
    const [, table, column, rest] = match
    const declaration = rest.trim()
    const notNull = /\bNOT\s+NULL\b/i.test(declaration)
    const defaultMatch = declaration.match(/\bDEFAULT\s+(.+?)(?:\s+NOT\s+NULL\b|$)/i)
    const type = declaration.replace(/\bNOT\s+NULL\b/i, '').replace(/\bDEFAULT\s+.*$/i, '').trim()
    parsed.push({
      table,
      column,
      type,
      notNull,
      defaultValue: defaultMatch ? defaultMatch[1].trim() : null,
    })
  }
  return parsed
}

interface TableColumn {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

/** Minimal surface of better-sqlite3 used here, so tests can drive it directly. */
export interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

function normalize(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase()
}

/** Whether the live column matches the migration's declaration exactly. */
export function columnMatches(declared: AddColumnStatement, live: TableColumn | undefined): boolean {
  if (!live) return false
  if (normalize(live.type) !== normalize(declared.type)) return false
  if ((live.notnull === 1) !== declared.notNull) return false
  return normalize(live.dflt_value) === normalize(declared.defaultValue)
}

/**
 * Record a fully-applied migration in the journal, or explain why we won't.
 * Never mutates schema — the only write is the journal row.
 */
export function repairJournalForAppliedMigration(
  sqlite: SqliteLike,
  migrationsFolder: string,
  error: unknown
): RepairOutcome {
  const duplicateColumn = extractDuplicateColumn(error)
  if (!duplicateColumn) return { repaired: false, reason: 'not-a-duplicate-column-error' }

  let migrations: JournalMigration[]
  try {
    migrations = readJournalMigrations(migrationsFolder)
  } catch {
    return { repaired: false, reason: 'journal-unreadable' }
  }

  // drizzle applies every migration newer than the newest recorded one.
  const lastApplied = sqlite
    .prepare(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`)
    .get() as { created_at?: number } | undefined
  const lastAppliedAt = Number(lastApplied?.created_at ?? -1)

  const candidate = migrations.find((migration) => {
    if (migration.when <= lastAppliedAt) return false
    const columns = parseAddColumnMigration(migration.statements)
    return columns?.some((c) => c.column === duplicateColumn) ?? false
  })
  if (!candidate) return { repaired: false, reason: 'no-pending-add-column-migration-for-column' }

  const declared = parseAddColumnMigration(candidate.statements)
  if (!declared) {
    return { repaired: false, reason: 'migration-is-not-pure-add-column', tag: candidate.tag }
  }

  for (const column of declared) {
    const live = (
      sqlite.prepare(`PRAGMA table_info(\`${column.table}\`)`).all() as TableColumn[]
    ).find((c) => c.name === column.column)
    if (!columnMatches(column, live)) {
      // Either the migration is genuinely unapplied, or the live column has a
      // different shape than the migration declares. Both must stay fatal.
      return {
        repaired: false,
        reason: live ? 'column-shape-mismatch' : 'column-missing',
        tag: candidate.tag,
      }
    }
  }

  sqlite
    .prepare(`INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`)
    .run(candidate.hash, candidate.when)

  return { repaired: true, tag: candidate.tag, columns: declared.map((c) => c.column) }
}
