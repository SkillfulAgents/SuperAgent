/**
 * Import the small host files of the data dir (settings.json, tenant-id,
 * .auth-secret, host container tokens, the platform client instance id and
 * the Browserbase context maps) into app records. The manifest and the rules
 * for absent and unparsable files are in `app-records/legacy-host-files.ts`.
 * Every insert is insert-if-absent, so a retry, or a record already imported
 * by migration 2 or 3 and edited since, is left as it is.
 */
import type { DataMigration, DataMigrationDb } from './index'

/**
 * The record store over a migration's handle, with the legacy files imported
 * into it. Migrations that read settings start here, so an install that skips
 * versions reads its real settings, not defaults.
 */
export async function legacyRecordStore(db: DataMigrationDb) {
  // Loaded here, not at the top: the database bootstrap module graph stays small.
  const { dbAppRecordStore } = await import('@shared/lib/app-records/record-store')
  const { importLegacyHostFiles } = await import('@shared/lib/app-records/legacy-host-files')
  const { getDataDir } = await import('@shared/lib/config/data-dir')
  const { captureException } = await import('@shared/lib/error-reporting')
  const store = dbAppRecordStore(db)
  const report = await importLegacyHostFiles(store, getDataDir())
  for (const { file, error } of report.skipped) {
    console.error(`[app-records] ${file} could not be parsed; not imported, original file retained:`, error)
    captureException(error, { tags: { area: 'app-records', op: 'import-legacy' }, extra: { file } })
  }
  if (report.imported.length > 0) {
    // Key names only: values hold secrets.
    console.log(`[app-records] Imported ${report.imported.length} host record(s): ${report.imported.join(', ')}`)
  }
  return store
}

export const importHostRecords: DataMigration = {
  id: 9,
  name: 'import-host-records',
  async run(db) {
    await legacyRecordStore(db)
  },
}
