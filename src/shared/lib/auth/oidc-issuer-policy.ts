import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { getExplicitAuthProviderIssuer } from './provider-config'

/** Preserve the deployment's issuer policy across the generic OAuth 1.7 move. */
export function oidcIssuerPolicy() {
  return {
    id: 'oidc-issuer-policy',
    hooks: {
      before: [{
        matcher: (context) => context.path === '/sign-in/social' || context.path === '/callback/:id',
        handler: createAuthMiddleware(async (context) => {
          const isCallback = context.path === '/callback/:id'
          // The core form-POST callback merges query over body before redirecting
          // to GET. Check the same values, and leave provider cancellation/errors
          // to its normal state validation and error redirect.
          const callback = isCallback ? { ...context.body, ...context.query } : undefined
          if (isCallback && (callback?.error || !callback?.code)) return

          const providerId = isCallback ? context.params?.id : context.body?.provider
          if (typeof providerId !== 'string') return
          const provider = context.context.socialProviders.find(candidate => candidate.id === providerId)
          if (!provider) return // The core endpoint reports unavailable providers.

          const explicitIssuer = getExplicitAuthProviderIssuer(providerId)
          if (explicitIssuer && explicitIssuer !== provider.issuer) {
            throw new APIError('BAD_REQUEST', {
              code: 'OIDC_ISSUER_MISMATCH', message: 'OIDC issuer validation failed',
            })
          }

          if (isCallback) {
            const expectedIssuer = explicitIssuer ?? provider.issuer
            if (!callback?.iss || !expectedIssuer || callback.iss !== expectedIssuer) {
              // A plain API error is intentional: reject before exchanging the
              // code, without trusting an unvalidated state's redirect target.
              throw new APIError('BAD_REQUEST', {
                code: callback?.iss ? 'OIDC_ISSUER_MISMATCH' : 'OIDC_ISSUER_MISSING',
                message: 'OIDC issuer validation failed',
              })
            }
          }
        }),
      }],
    },
  } satisfies BetterAuthPlugin
}
