import crypto from 'crypto'
import type { AppRecordStore } from '@shared/lib/app-records/record-store'
import { appRecordStore, getOrCreateRecord } from '@shared/lib/app-records/records'
import { AUTH_SECRET_RECORD_KEY, authSecretRecordSchema } from '@shared/lib/app-records/record-schemas'

/**
 * Get or create the Better Auth secret.
 *
 * Priority:
 * 1. BETTER_AUTH_SECRET env var (explicit override)
 * 2. The deployment's persisted secret (app record `auth-secret`, imported
 *    from `~/.superagent/.auth-secret` by data migration 9)
 * 3. A new secret, committed with insert-if-absent so concurrent first uses
 *    agree on one
 *
 * A database error or an invalid stored secret throws rather than replacing
 * it: sessions, and the S3 volume credentials sealed under a key derived from
 * this secret (volumes/s3-credentials.ts), depend on it staying the same.
 */
export async function getOrCreateAuthSecret(store?: AppRecordStore): Promise<string> {
  const envSecret = process.env.BETTER_AUTH_SECRET
  if (envSecret) {
    return envSecret
  }
  // The store only when it is needed: the env secret works before records are installed.
  return getOrCreateRecord(store ?? appRecordStore(), AUTH_SECRET_RECORD_KEY, authSecretRecordSchema, () =>
    crypto.randomBytes(32).toString('base64'),
  )
}
