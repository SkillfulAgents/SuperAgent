import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'

import { Authenticated } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { getServerFacts } from '@shared/lib/facts/server-facts'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAuthStatusForUser } from '@shared/lib/services/platform-auth-service'
import {
  AccountDeletionDeliveryError,
  deletionEventPlatform,
  getAccountDeletionRequest,
  requestAccountDeletion,
  type DeletionAccount,
} from '@shared/lib/account-deletion/account-deletion-service'
import type {
  AccountDeletionRecord,
  AccountDeletionStatus,
} from '@shared/lib/account-deletion/account-deletion-schema'

/**
 * The Account screen's "Request account deletion" (App Review guideline
 * 5.1.1(v)): the caller's Gamut account, as the server knows it, asks support
 * to delete it. See docs/account-deletion.md.
 */
const accountDeletion = new Hono()

accountDeletion.use('*', Authenticated())

const requestBodySchema = z.object({
  /** The account the person was shown when they confirmed. */
  userId: z.string().min(1),
})

/**
 * The caller's Gamut account, read now. Null when there is none to delete from
 * here: not connected, or connected with a key that names an organization and
 * no person.
 */
async function deletionAccountOf(c: Context): Promise<DeletionAccount | null> {
  const status = await getPlatformAuthStatusForUser(getCurrentUserId(c))
  if (!status.connected || !status.userId) return null
  return {
    userId: status.userId,
    workspaceUrl: getPlatformBaseUrl(),
    tenantId: await getTenantId().catch(() => null),
  }
}

function statusOf(record: AccountDeletionRecord | null): AccountDeletionStatus {
  return {
    available: true,
    request: record && {
      requestId: record.requestId,
      requestedAt: record.requestedAt,
      accepted: record.acceptedAt !== null,
    },
  }
}

accountDeletion.get('/', async (c) => {
  const account = await deletionAccountOf(c)
  if (!account) return c.json({ available: false, request: null } satisfies AccountDeletionStatus)
  return c.json(statusOf(await getAccountDeletionRequest(account.userId)))
})

accountDeletion.post('/', async (c) => {
  const body = requestBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'Missing account' }, 400)

  const account = await deletionAccountOf(c)
  // The person confirmed for the account on their screen; a different one
  // connected since must not be the one the request names.
  if (!account || account.userId !== body.data.userId) {
    return c.json({ error: 'Your account changed. Reopen Settings and try again.' }, 409)
  }

  try {
    const record = await requestAccountDeletion(account, { platform: deletionEventPlatform(getServerFacts()) })
    // The usage-analytics record of the request's outcome, as on iOS. Unlike
    // the request itself it follows the analytics setting.
    trackServerEvent('account_deletion_request_result', { outcome: 'sent' })
    return c.json(statusOf(record))
  } catch (error) {
    if (!(error instanceof AccountDeletionDeliveryError)) throw error
    console.warn('[AccountDeletion] Delivery was not confirmed:', error.message)
    trackServerEvent('account_deletion_request_result', { outcome: 'failed', reason_code: error.reason })
    return c.json(
      {
        error: "We couldn't confirm delivery of your request. Please try again. Retrying uses the same request ID.",
        reason: error.reason,
      },
      502,
    )
  }
})

export default accountDeletion
