import { execSync } from 'child_process'
import crypto from 'crypto'
import os from 'os'

import { getOrCreateRecord, type RecordDb } from '@shared/lib/app-records/records'
import {
  PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY,
  platformClientInstanceIdRecordSchema,
} from '@shared/lib/app-records/record-schemas'

export function getPlatformDeviceName(): string {
  if (process.platform === 'darwin') {
    try {
      return execSync('scutil --get ComputerName', { encoding: 'utf8' }).trim()
    } catch {
      // fall through
    }
  }
  return os.hostname().trim() || 'Gamut Device'
}

/**
 * This deployment's client instance id for platform device auth, created once
 * (insert-if-absent, so concurrent first uses agree). Imported from
 * `.platform-auth/client-instance-id` by data migration 9.
 */
export async function getOrCreatePlatformClientInstanceId(
  db?: RecordDb,
): Promise<string> {
  return getOrCreateRecord(PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY, platformClientInstanceIdRecordSchema, () =>
    crypto.randomUUID(), db)
}
