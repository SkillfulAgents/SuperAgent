import { z } from 'zod'

import { getAuth } from '@shared/lib/auth'
import { isPlatformControlledAuth } from '@shared/lib/auth/auth-settings'
import { captureException } from '@shared/lib/error-reporting'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  getPlatformAuthStatus,
  PLATFORM_AUTH_PROVIDER_ID,
} from '@shared/lib/services/platform-auth-service'
import {
  type BillingEmbedErrorCode,
  type BillingEmbedSession,
  type BillingEmbedView,
} from '@shared/lib/services/platform-billing-embed-schema'

export {
  BILLING_EMBED_VIEWS,
  parseBillingEmbedView,
  type BillingEmbedErrorCode,
  type BillingEmbedSession,
  type BillingEmbedView,
} from '@shared/lib/services/platform-billing-embed-schema'

const EXCHANGE_TIMEOUT_MS = 10_000

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

const embedSessionResponseSchema = z.object({ embed_url: z.string().url() })
const embedErrorResponseSchema = z.object({ error: z.string() })

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

async function readPlatformErrorCode(res: Response): Promise<string | null> {
  const parsed = embedErrorResponseSchema.safeParse(await res.json().catch(() => null))
  return parsed.success ? parsed.data.error : null
}

// Trades the acting user's platform OIDC access token (refreshed by Better Auth
// when expired) for a one-time embed URL. Cloud-only: the platform accepts the
// parent origin only when it matches this org's registered deployment.
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
    // The platform also 403s when this deployment's origin is not registered
    // for the org (custom domain, preview host): that is not a role problem.
    if ((await readPlatformErrorCode(res)) === 'parent_not_registered') {
      throw new BillingEmbedError('In-app billing is not available from this address.', 'not_available', 400)
    }
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
