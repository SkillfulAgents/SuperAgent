import { v4 as uuidv4 } from 'uuid'
import { getOrCreateRecord, type RecordDb } from '@shared/lib/app-records/records'
import { TENANT_ID_RECORD_KEY, tenantIdRecordSchema } from '@shared/lib/app-records/record-schemas'

/**
 * The deployment's persistent tenant id, created on first use. Every process
 * of a deployment reads the same record: a process starting on an existing
 * database never makes a new one, and concurrent first uses on an empty
 * database all return the id that was committed. A database error or an
 * invalid stored id throws rather than replacing it.
 */
export async function getTenantId(db?: RecordDb): Promise<string> {
  return getOrCreateRecord(TENANT_ID_RECORD_KEY, tenantIdRecordSchema, () => uuidv4(), db)
}
