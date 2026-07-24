import { Hono } from 'hono'
import { getAuth } from '@shared/lib/auth/index'
import { getGenericOAuthProviderConfigs } from '@shared/lib/auth/provider-config'
import { sanitizeReturnTo } from '@shared/lib/auth/safe-return-to'
import { captureException } from '@shared/lib/error-reporting'

const PLATFORM_PROVIDER_ID = 'platform'

function resolvePlatformProviderId(): string | null {
  const providers = getGenericOAuthProviderConfigs()
  if (providers.some((p) => p.providerId === PLATFORM_PROVIDER_ID)) {
    return PLATFORM_PROVIDER_ID
  }
  return providers[0]?.providerId ?? null
}

function appendSetCookies(from: Headers, to: Headers): void {
  const getSetCookie = (from as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') {
    for (const cookie of getSetCookie.call(from)) {
      to.append('Set-Cookie', cookie)
    }
    return
  }
  const single = from.get('set-cookie')
  if (single) to.append('Set-Cookie', single)
}

// GET /auth/platform/start?return_to=/ — RP-initiated Platform OIDC launcher (SUP-466).
const platformSsoStart = new Hono()

platformSsoStart.get('/platform/start', async (c) => {
  const returnTo = sanitizeReturnTo(c.req.query('return_to'))
  const providerId = resolvePlatformProviderId()
  if (!providerId) {
    return c.redirect('/', 302)
  }

  try {
    const auth = getAuth()
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (session?.session) {
      // Reuse an acceptable existing deployment session; account-switch requires logout.
      return c.redirect(returnTo, 302)
    }

    const { headers, response } = await auth.api.signInWithOAuth2({
      body: {
        providerId,
        callbackURL: returnTo,
        errorCallbackURL: '/',
      },
      headers: c.req.raw.headers,
      returnHeaders: true,
    })

    const url = response && typeof response === 'object' && 'url' in response
      ? String((response as { url?: unknown }).url ?? '')
      : ''
    if (!url) {
      return c.redirect('/', 302)
    }

    const redirect = c.redirect(url, 302)
    if (headers) appendSetCookies(headers, redirect.headers)
    return redirect
  } catch (error) {
    captureException(error, {
      tags: { area: 'auth', op: 'platform-sso-start' },
    })
    console.warn('[platform-sso-start] failed to start Platform OIDC', error)
    return c.redirect('/', 302)
  }
})

export default platformSsoStart
