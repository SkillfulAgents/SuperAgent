/**
 * The migration manifest: every small host record that used to be a file in
 * the data dir and is now an app record, and how each one is imported.
 *
 * Imported (data migration 9, and first thing in migrations 2 and 3, which
 * read settings):
 *   settings.json                         → `settings`
 *   tenant-id                             → `tenant-id`
 *   .auth-secret                          → `auth-secret` (BETTER_AUTH_SECRET still wins)
 *   host-container-tokens.json            → `host-container-token:<agent>`, one per agent
 *   .platform-auth/client-instance-id     → `platform-client-instance-id`
 *   browserbase-contexts.json             → `browser-context:browserbase:<instance>`
 *   platform-browserbase-contexts.json    → `browser-context:platform:<key>`
 *
 * Deliberately left where they are:
 *   .vault-key                 encryption key custody belongs to KeyManager (SUP-1509)
 *   fatal-crash-marker.json    written synchronously by a dying Electron main process,
 *                              before any async work; must not depend on the database
 *   superagent.db              the database itself
 *   agents/, volumes/, model-icons/, profile-photos/, integration-attachments/,
 *   tmp/uploads/               workspaces and blobs, in their own storage streams
 *   skillset-cache/            a cache that can be fetched again
 *   host-browser-profiles/, browser-profiles/, lima/, lima-packages/, wsl2/,
 *   credential-broker/         this machine's runtime state (Chrome profiles, VMs, the
 *                              Apple Passwords helper), meaningless on another host
 *
 * Every import is insert-if-absent, so a retry after an interrupted run, or a
 * value already edited in the database, is never overwritten. A file that is
 * absent has nothing to import. A file that cannot be parsed is reported and
 * skipped, and left on disk untouched: the old readers also fell back for
 * such a file (settings to defaults, tokens and ids to new ones), and a boot
 * that cannot proceed would be worse. Any other read error fails the
 * migration, so it runs again on the next boot. The files are never deleted
 * here; after the import nothing reads or writes them.
 */
import fs from 'fs'
import path from 'path'
import type { z } from 'zod'
import type { AppRecordStore } from './record-store'
import { parseRecordValue, serializeRecordValue } from './records'
import {
  AUTH_SECRET_RECORD_KEY,
  PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY,
  SETTINGS_RECORD_KEY,
  TENANT_ID_RECORD_KEY,
  authSecretRecordSchema,
  browserContextIdRecordSchema,
  browserContextKey,
  hostContainerTokenKey,
  hostContainerTokenRecordSchema,
  legacyStringMapSchema,
  platformClientInstanceIdRecordSchema,
  tenantIdRecordSchema,
} from './record-schemas'
import { persistedSettingsSchema } from '../config/settings-schema'

/** One file of the manifest: where it lived and the records it becomes. */
export interface LegacyHostFile {
  /** Path relative to the data dir. */
  readonly file: string
  /** The records to insert, from the file's content; throws when the content is invalid. */
  records(content: string): Array<{ key: string; value: string }>
}

function plainText(key: string, schema: z.ZodType<string, string>) {
  return (content: string) => [{ key, value: serializeRecordValue(key, content.trim(), schema) }]
}

function stringMap(keyOf: (entry: string) => string, schema: z.ZodType<string, string>) {
  return (content: string) => {
    const map = parseRecordValue('legacy-map', content, legacyStringMapSchema)
    return Object.entries(map).map(([entry, value]) => {
      const key = keyOf(entry)
      return { key, value: serializeRecordValue(key, value, schema) }
    })
  }
}

export const LEGACY_HOST_FILES: readonly LegacyHostFile[] = [
  {
    file: 'settings.json',
    // Stored as it was written: the defaults merge happens on every read.
    records: (content) => [{
      key: SETTINGS_RECORD_KEY,
      value: serializeRecordValue(
        SETTINGS_RECORD_KEY,
        parseRecordValue(SETTINGS_RECORD_KEY, content, persistedSettingsSchema),
        persistedSettingsSchema,
      ),
    }],
  },
  { file: 'tenant-id', records: plainText(TENANT_ID_RECORD_KEY, tenantIdRecordSchema) },
  { file: '.auth-secret', records: plainText(AUTH_SECRET_RECORD_KEY, authSecretRecordSchema) },
  { file: 'host-container-tokens.json', records: stringMap(hostContainerTokenKey, hostContainerTokenRecordSchema) },
  {
    file: path.join('.platform-auth', 'client-instance-id'),
    records: plainText(PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY, platformClientInstanceIdRecordSchema),
  },
  {
    file: 'browserbase-contexts.json',
    records: stringMap((key) => browserContextKey('browserbase', key), browserContextIdRecordSchema),
  },
  {
    file: 'platform-browserbase-contexts.json',
    records: stringMap((key) => browserContextKey('platform', key), browserContextIdRecordSchema),
  },
]

export interface LegacyImportReport {
  /** Keys this call inserted. */
  imported: string[]
  /** Files that could not be parsed, left on disk. */
  skipped: Array<{ file: string; error: unknown }>
}

/**
 * Import every file of the manifest under `dataDir` that the database does
 * not already hold. Idempotent and safe to call from more than one migration.
 */
export async function importLegacyHostFiles(
  store: AppRecordStore,
  dataDir: string,
  files: readonly LegacyHostFile[] = LEGACY_HOST_FILES,
): Promise<LegacyImportReport> {
  const report: LegacyImportReport = { imported: [], skipped: [] }
  for (const entry of files) {
    const filePath = path.join(dataDir, entry.file)
    let content: string
    try {
      content = await fs.promises.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let records: Array<{ key: string; value: string }>
    try {
      records = entry.records(content)
    } catch (error) {
      report.skipped.push({ file: entry.file, error })
      continue
    }
    for (const record of records) {
      if (await store.insertIfAbsent(record.key, record.value)) report.imported.push(record.key)
    }
  }
  return report
}
