import crypto from 'crypto'
import { DEFAULT_AMPLITUDE_KEY } from '@shared/lib/analytics/constants'
import { compareAndSetRecord, getOrCreateRecord, readRecord, serializeRecordValue } from '@shared/lib/app-records/records'
import { accountDeletionRequestKey } from '@shared/lib/app-records/record-schemas'
import type { Os, ServerDistribution } from '@shared/lib/facts/facts-schema'
import {
  accountDeletionRecordSchema,
  amplitudeAcknowledgementSchema,
  opaqueIdSchema,
  type AccountDeletionRecord,
} from './account-deletion-schema'

/**
 * The account-deletion request of the Account screen: one event,
 * `account_deletion_requested`, sent to the Amplitude project the support
 * consumer subscribes to. Same event and contract as the iOS app's; see
 * docs/account-deletion.md.
 *
 * It is a request the account holder confirmed, not usage analytics: it is
 * sent whatever the analytics setting says, carries no analytics context, and
 * is acknowledged only when Amplitude says it ingested exactly this event.
 * The ingestion key is public, so the event proves nothing about who sent it;
 * the consumer verifies the account before anything is deleted.
 */

export const ACCOUNT_DELETION_EVENT_TYPE = 'account_deletion_requested'
const AMPLITUDE_ENDPOINT = 'https://api2.amplitude.com/2/httpapi'
const DELIVERY_TIMEOUT_MS = 15_000

export type AccountDeletionFailure =
  | 'invalid_identity'
  | 'invalid_workspace_address'
  | 'no_api_key'
  | 'transport_failed'
  | 'rejected'
  | 'invalid_response'
  | 'unacknowledged'

export class AccountDeletionDeliveryError extends Error {
  constructor(readonly reason: AccountDeletionFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'AccountDeletionDeliveryError'
  }
}

/** The account a request is for, as the server resolved it for the caller. */
export interface DeletionAccount {
  /** The account's id where it lives: the platform's user id for a Gamut account. */
  userId: string
  /** Where the account lives. Credentials, query and fragment are dropped. */
  workspaceUrl: string
  tenantId: string | null
}

/** What the event's `platform` says about the app that sent it. */
export function deletionEventPlatform(facts: { os: Os; distribution: ServerDistribution }): string {
  if (facts.distribution === 'deployment') return 'web'
  switch (facts.os) {
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    case 'linux': return 'linux'
    case 'other': return 'desktop'
  }
}

/** An http(s) address without credentials, query or fragment; throws when it is anything else. */
export function sanitizeWorkspaceUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AccountDeletionDeliveryError('invalid_workspace_address')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new AccountDeletionDeliveryError('invalid_workspace_address')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const sanitized = url.toString()
  if (Buffer.byteLength(sanitized) > 1024) throw new AccountDeletionDeliveryError('invalid_workspace_address')
  return sanitized
}

/** The stored request of `userId`; null when none was ever made on this install. */
export async function getAccountDeletionRequest(userId: string): Promise<AccountDeletionRecord | null> {
  if (!opaqueIdSchema.safeParse(userId).success) return null
  return (await readRecord(accountDeletionRequestKey(userId), accountDeletionRecordSchema))?.value ?? null
}

/** The Amplitude HTTP V2 body of a request. Exported for the contract test. */
export function accountDeletionPayload(record: AccountDeletionRecord, apiKey: string, platform: string) {
  return {
    api_key: apiKey,
    events: [
      {
        event_type: ACCOUNT_DELETION_EVENT_TYPE,
        user_id: record.userId,
        time: record.requestedAt,
        insert_id: record.requestId,
        // Not part of any usage session.
        session_id: -1,
        platform,
        event_properties: {
          request_id: record.requestId,
          event_id: record.requestId,
          event_version: 1,
          workspace_url: record.workspaceUrl,
          ...(record.tenantId ? { tenantId: record.tenantId } : {}),
          source: 'client',
          surface: 'app',
          platform,
        },
        ...(record.tenantId ? { groups: { tenantId: record.tenantId } } : {}),
      },
    ],
    // Account ids may be short; no device id is sent to make up the length.
    options: { min_id_length: 1 },
  }
}

async function deliver(record: AccountDeletionRecord, platform: string, fetchImpl: typeof fetch): Promise<void> {
  const apiKey = DEFAULT_AMPLITUDE_KEY?.trim()
  if (!apiKey) throw new AccountDeletionDeliveryError('no_api_key')

  let body: unknown
  try {
    const response = await fetchImpl(AMPLITUDE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountDeletionPayload(record, apiKey, platform)),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })
    if (response.status !== 200) throw new AccountDeletionDeliveryError('rejected', String(response.status))
    body = await response.json().catch(() => null)
  } catch (error) {
    if (error instanceof AccountDeletionDeliveryError) throw error
    throw new AccountDeletionDeliveryError('transport_failed', error instanceof Error ? error.message : String(error))
  }
  if (body === null || typeof body !== 'object') throw new AccountDeletionDeliveryError('invalid_response')
  if (!amplitudeAcknowledgementSchema.safeParse(body).success) throw new AccountDeletionDeliveryError('unacknowledged')
}

/**
 * Sends the account's deletion request and returns it once Amplitude
 * acknowledged it. Call only after the account holder confirmed.
 *
 * The request is stored before it is sent (insert-if-absent, so concurrent
 * calls share one request id), and a call after a failure sends that same
 * request again. One already acknowledged is returned without sending.
 * Throws {@link AccountDeletionDeliveryError} when delivery is not confirmed;
 * the outcome may then be uncertain, which is why a retry reuses the id.
 */
export async function requestAccountDeletion(
  account: DeletionAccount,
  options: { platform: string; fetch?: typeof fetch; now?: () => number },
): Promise<AccountDeletionRecord> {
  const now = options.now ?? Date.now
  const userId = opaqueIdSchema.safeParse(account.userId)
  const tenantId = opaqueIdSchema.nullable().safeParse(account.tenantId)
  if (!userId.success || !tenantId.success) throw new AccountDeletionDeliveryError('invalid_identity')
  const workspaceUrl = sanitizeWorkspaceUrl(account.workspaceUrl)

  const key = accountDeletionRequestKey(userId.data)
  const record = await getOrCreateRecord(key, accountDeletionRecordSchema, () => ({
    requestId: crypto.randomUUID(),
    requestedAt: now(),
    userId: userId.data,
    tenantId: tenantId.data,
    workspaceUrl,
    acceptedAt: null,
  }))
  if (record.acceptedAt !== null) return record

  await deliver(record, options.platform, options.fetch ?? fetch)

  // Mark it accepted, unless a concurrent call already did.
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await readRecord(key, accountDeletionRecordSchema)
    if (!stored) break
    if (stored.value.acceptedAt !== null) return stored.value
    const accepted = { ...stored.value, acceptedAt: now() }
    if (await compareAndSetRecord(key, stored.revision, serializeRecordValue(key, accepted, accountDeletionRecordSchema))) {
      return accepted
    }
  }
  // Delivered, but the mark could not be written: say so rather than fail a
  // request that did go out. The next read shows it unsent, and sending it
  // again repeats the same request id.
  return { ...record, acceptedAt: now() }
}
