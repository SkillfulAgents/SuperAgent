import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'

import { Authenticated } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { buildPlatformLoginUrl, getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from '@shared/lib/services/platform-device-service'
import {
  getPlatformAuthStatus,
  getEnrichedPlatformAuthStatus,
  savePlatformAuth,
  revokePlatformToken,
} from '@shared/lib/services/platform-auth-service'
import {
  dismissDownloadNonceOffer,
  getDownloadNonceOffer,
  redeemDownloadNonce,
  DownloadNonceUnavailableError,
} from '@shared/lib/services/download-nonce-service'
import { platformService } from '@shared/lib/services/platform-service'
import { PlatformRequestError } from '@shared/lib/platform-auth/platform-fetch'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { setErrorReportingUser } from '@shared/lib/error-reporting'

const platformAuth = new Hono()

platformAuth.use('*', Authenticated())

// SUP-201: In AUTH_MODE platform credentials are deployment-managed (the
// `PLATFORM_TOKEN` env var) and the settings-backed connection is a single
// deployment-global record. `savePlatformAuth`/`revokePlatformToken` write and
// clear that shared record while ignoring the caller, so guarding these routes
// with only `Authenticated()` let any logged-in user overwrite or wipe the
// workspace-wide platform identity (breaking everyone's platform-backed flows).
// The UI already renders platform auth read-only in auth mode ("managed by this
// deployment"); mirror that on the API by rejecting the mutating endpoints
// outright. Connection changes are made via the deployment environment bundle.
// Auth mode is web-only (Electron's OAuth `/complete` caller is never in auth
// mode), so this does not affect the local/desktop connect flow.
const rejectMutationInAuthMode: MiddlewareHandler = async (c, next) => {
  if (isAuthMode()) {
    return c.json(
      { error: 'Platform access is managed by this deployment and cannot be changed here.' },
      403,
    )
  }
  return next()
}

platformAuth.get('/', async (c) => {
  const userId = getCurrentUserId(c)
  return c.json({
    ...(await getEnrichedPlatformAuthStatus(userId)),
    platformBaseUrl: getPlatformBaseUrl(),
  })
})

// Billing snapshot for the Account screen. Runs in the user's request scope, so
// the platform fetch interceptor attributes the bearer to the acting member
// (correct per-user seat balance in auth_mode). Falls back to the non-auth
// cache on a transient failure so a blip doesn't blank the UI.
platformAuth.get('/billing', async (c) => {
  if (!getPlatformAuthStatus().connected) {
    return c.json({ connected: false })
  }
  try {
    const billing = await platformService.refreshBilling()
    return c.json({ connected: true, billing })
  } catch (error) {
    // Serve the last-known snapshot so a transient blip doesn't blank the UI,
    // tagged with when it was fetched so the client can show "Last updated …".
    const cached = platformService.getCachedBilling()
    if (cached) {
      return c.json({
        connected: true,
        billing: cached,
        stale: true,
        lastRefreshedAt: platformService.getLastRefreshedAt(),
      })
    }
    if (error instanceof PlatformRequestError) {
      return c.json({ connected: true, error: error.message }, error.status as ContentfulStatusCode)
    }
    throw error
  }
})

platformAuth.post('/initiate', (c) => {
  const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
  const clientInstanceId = getOrCreatePlatformClientInstanceId()
  const deviceName = getPlatformDeviceName()

  return c.json({
    loginUrl: buildPlatformLoginUrl(protocol, {
      clientInstanceId,
      deviceName,
    }),
    platformBaseUrl: getPlatformBaseUrl(),
  })
})

platformAuth.post('/complete', rejectMutationInAuthMode, async (c) => {
  const userId = getCurrentUserId(c)
  const body = await c.req.json<{
    token?: string
    email?: string | null
    label?: string | null
    orgId?: string | null
    orgName?: string | null
    role?: string | null
    userId?: string | null
    memberId?: string | null
  }>()

  if (!body.token?.trim()) {
    return c.json({ error: 'Missing token' }, 400)
  }

  let status
  try {
    status = await savePlatformAuth(userId, {
      token: body.token,
      email: body.email,
      label: body.label,
      orgId: body.orgId,
      orgName: body.orgName,
      role: body.role,
      userId: body.userId,
      memberId: body.memberId,
    })
  } catch (error) {
    if (error instanceof PlatformRequestError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode)
    }
    throw error
  }

  // Update server-side error reporting identity so Sentry events are attributable
  setErrorReportingUser({
    id: status.tokenPreview || undefined,
    email: status.email || undefined,
  })

  return c.json(status)
})

// Download-carried enrollment: a nonce recovered from the installer's
// surroundings (filename / download-URL metadata) lets onboarding offer
// "Continue as <email>" instead of the browser handoff. No nonce → these
// endpoints report unavailable and the flow is unchanged.
platformAuth.get('/download-nonce', async (c) => {
  return c.json(await getDownloadNonceOffer())
})

platformAuth.post('/download-nonce/redeem', rejectMutationInAuthMode, async (c) => {
  const userId = getCurrentUserId(c)
  let status
  try {
    status = await redeemDownloadNonce(userId)
  } catch (error) {
    if (error instanceof DownloadNonceUnavailableError) {
      return c.json({ error: error.message, expired: true }, 410)
    }
    if (error instanceof PlatformRequestError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode)
    }
    throw error
  }

  setErrorReportingUser({
    id: status.tokenPreview || undefined,
    email: status.email || undefined,
  })

  return c.json(status)
})

platformAuth.post('/download-nonce/dismiss', (c) => {
  dismissDownloadNonceOffer()
  return c.json({ success: true })
})

platformAuth.post('/revoke', rejectMutationInAuthMode, async (c) => {
  const body = await c.req.json<{ clearLocal?: boolean }>().catch(() => ({} as { clearLocal?: boolean }))
  const success = await revokePlatformToken({ clearLocal: body.clearLocal })

  // Clear server-side error reporting identity (falls back to tenant ID)
  setErrorReportingUser(null)

  return c.json({ success })
})

export default platformAuth
