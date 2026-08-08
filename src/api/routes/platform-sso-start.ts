import { Hono } from 'hono'
import { getAuth } from '@shared/lib/auth/index'
import { getGenericOAuthProviderConfigs } from '@shared/lib/auth/provider-config'
import { sanitizeReturnTo } from '@shared/lib/auth/safe-return-to'
import { captureException } from '@shared/lib/error-reporting'

const PLATFORM_PROVIDER_ID = 'platform'
const HANDOFF_PROMPT_MAX = 400
const HANDOFF_MODEL_RE = /^[A-Za-z0-9._/-]{1,64}$/

function resolvePlatformProviderId(): string | null {
  const providers = getGenericOAuthProviderConfigs()
  // Fail closed: Platform contract requires the literal provider id.
  return providers.some((p) => p.providerId === PLATFORM_PROVIDER_ID)
    ? PLATFORM_PROVIDER_ID
    : null
}

/** Append validated marketing-handoff params to an already-sanitized internal path. */
function withSignupHandoff(
  returnTo: string,
  prompt: string | undefined,
  model: string | undefined,
): string {
  try {
    const url = new URL(returnTo, 'http://internal')
    const cleanPrompt = prompt?.replace(/[\r\n\0]/g, '').trim().slice(0, HANDOFF_PROMPT_MAX)
    if (cleanPrompt) url.searchParams.set('prompt', cleanPrompt)
    if (model && HANDOFF_MODEL_RE.test(model)) url.searchParams.set('model', model)
    // hash included: sanitizeReturnTo permits fragments and returns them verbatim.
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    // Fail open: keep the sanitized return_to rather than strand the SSO hop.
    return returnTo
  }
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
  const target = withSignupHandoff(returnTo, c.req.query('prompt'), c.req.query('model'))
  const providerId = resolvePlatformProviderId()
  if (!providerId) {
    return c.redirect('/', 302)
  }

  try {
    const auth = getAuth()
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (session?.session) {
      // Reuse an acceptable existing deployment session; account-switch requires logout.
      return c.redirect(target, 302)
    }

    const { headers, response } = await auth.api.signInWithOAuth2({
      body: {
        providerId,
        callbackURL: target,
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
