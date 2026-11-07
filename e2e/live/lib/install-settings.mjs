/**
 * An install's settings, read from outside the app's module graph.
 *
 * Settings live in the app database: the `settings` row of `app_records`. An
 * install that has not yet booted a version with that table keeps them in
 * `settings.json`, which that first boot imports (data migration 9). After the
 * import nothing reads or writes the file, so from then on it is stale and the
 * row is the answer.
 *
 * Read-only: harnesses use this on the developer's real installs.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The data migration that imports settings.json and the other host files. */
const IMPORT_HOST_RECORDS_MIGRATION = 9

/**
 * The settings the install runs with, or null when it has none on record and
 * no settings.json either.
 *
 * @param {string} dataDir
 * @returns {Record<string, any> | null}
 */
export function readInstallSettings(dataDir) {
  const imported = readSettingsRecord(dataDir)
  if (imported !== undefined) return imported
  const file = path.join(dataDir, 'settings.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * The settings row once the files have been imported (an empty object when the
 * install had none), or undefined while settings.json is still the authority.
 *
 * @param {string} dataDir
 * @returns {Record<string, any> | undefined}
 */
function readSettingsRecord(dataDir) {
  const dbPath = path.join(dataDir, 'superagent.db')
  if (!existsSync(dbPath)) return undefined
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hasLedger = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'data_migrations'").get()
    if (!hasLedger) return undefined
    const importedFiles = db.prepare('select 1 from data_migrations where id = ?').get(IMPORT_HOST_RECORDS_MIGRATION)
    if (!importedFiles) return undefined
    const row = db.prepare("select value from app_records where key = 'settings'").get()
    return row ? JSON.parse(String(row.value)) : {}
  } finally {
    db.close()
  }
}
