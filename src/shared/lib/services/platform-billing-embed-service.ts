import { z } from 'zod'

import { getAuth } from '@shared/lib/auth'
import { isPlatformControlledAuth } from '@shared/lib/auth/auth-settings'
import { captureException } from '@shared/lib/error-reporting'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  getPlatformAuthStatus,
  PLATFORM_AUTH_PROVIDER_ID,
} from '@shared/lib/services/platform-auth-service'

const EXCHANGE_TIMEOUT_MS = 10_000

export type BillingEmbedErrorCode = 'not_available' | 'reconnect' | 'forbidden' | 'platform_error'

export class BillingEmbedError extends Error {
  constructor(
    message: string,
    readonly code: BillingEmbedErrorCode,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BillingEmbedError'
  }
}

export interface BillingEmbedSession {
  /** One-time URL to load in the iframe; boots the partitioned platform session. */
  embedUrl: string
  /** Origin the renderer must accept `message` events from. */
  platformOrigin: string
}

const embedSessionResponseSchema = z.object({ embed_url: z.string().url() })

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// Trades the acting user's platform OIDC access token (refreshed by Better Auth
// when expired) for a one-time embed URL. Cloud-only: the platform accepts the
// parent origin only when it matches this org's registered deployment.
// One chrome-less platform panel per paywall CTA (mirrors the platform's EMBED_VIEWS).
export const BILLING_EMBED_VIEWS = ['topup', 'subscribe', 'payment'] as const
export type BillingEmbedView = (typeof BILLING_EMBED_VIEWS)[number]
export function parseBillingEmbedView(value: unknown): BillingEmbedView | undefined {
  return BILLING_EMBED_VIEWS.find((v) => v === value)
}

export async function createBillingEmbedSession(input: {
  headers: Headers
  parentOrigin: string
  intent?: 'topup'
  /** `topup`: chrome-less top-up panel sized for a chat card; absent: full billing tab. */
  view?: BillingEmbedView
}): Promise<BillingEmbedSession> {
  const origin = safeOrigin(getPlatformBaseUrl())
  if (!isPlatformControlledAuth() || !origin) {
    throw new BillingEmbedError('In-app billing is only available on cloud workspaces.', 'not_available', 400)
  }
  const orgId = getPlatformAuthStatus().orgId
  if (!orgId) {
    throw new BillingEmbedError('This workspace is not connected to the platform.', 'not_available', 400)
  }

  let accessToken: string | null | undefined
  try {
    const tokens = await getAuth().api.getAccessToken({
      body: { providerId: PLATFORM_AUTH_PROVIDER_ID },
      headers: input.headers,
    })
    accessToken = tokens?.accessToken
  } catch (error) {
    captureException(error, { tags: { area: 'billing-embed', op: 'get-access-token' } })
    throw new BillingEmbedError('Sign in again to manage billing in the app.', 'reconnect', 401)
  }
  if (!accessToken) {
    throw new BillingEmbedError('Sign in again to manage billing in the app.', 'reconnect', 401)
  }

  let res: Response
  try {
    res = await fetch(`${origin}/api/embed/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        org_id: orgId,
        parent_origin: input.parentOrigin,
        intent: input.intent,
        view: input.view,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    captureException(error, { tags: { area: 'billing-embed', op: 'exchange' } })
    throw new BillingEmbedError('Could not reach the platform. Please try again.', 'platform_error', 502)
  }

  if (res.status === 401) {
    throw new BillingEmbedError('Sign in again to manage billing in the app.', 'reconnect', 401)
  }
  if (res.status === 403) {
    throw new BillingEmbedError('Only workspace owners and admins can manage billing.', 'forbidden', 403)
  }
  if (!res.ok) {
    captureException(new Error(`embed session exchange failed: ${res.status}`), {
      tags: { area: 'billing-embed', op: 'exchange-status' },
    })
    throw new BillingEmbedError('The platform could not start a billing session.', 'platform_error', 502)
  }

  const parsed = embedSessionResponseSchema.safeParse(await res.json().catch(() => null))
  // The renderer will frame this URL: refuse anything that is not the platform itself.
  if (!parsed.success || safeOrigin(parsed.data.embed_url) !== origin) {
    captureException(new Error('embed session exchange returned an unexpected body'), {
      tags: { area: 'billing-embed', op: 'exchange-body' },
    })
    throw new BillingEmbedError('The platform returned an invalid billing session.', 'platform_error', 502)
  }

  return { embedUrl: parsed.data.embed_url, platformOrigin: origin }
}
