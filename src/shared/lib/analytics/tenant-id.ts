import { v4 as uuidv4 } from 'uuid'
import type { AppRecordStore } from '@shared/lib/app-records/record-store'
import { appRecordStore, getOrCreateRecord } from '@shared/lib/app-records/records'
import { TENANT_ID_RECORD_KEY, tenantIdRecordSchema } from '@shared/lib/app-records/record-schemas'

/**
 * The deployment's persistent tenant id, created on first use. Every process
 * of a deployment reads the same record: a process starting on an existing
 * database never makes a new one, and concurrent first uses on an empty
 * database all return the id that was committed. A database error or an
 * invalid stored id throws rather than replacing it.
 */
export async function getTenantId(store: AppRecordStore = appRecordStore()): Promise<string> {
  return getOrCreateRecord(store, TENANT_ID_RECORD_KEY, tenantIdRecordSchema, () => uuidv4())
}
