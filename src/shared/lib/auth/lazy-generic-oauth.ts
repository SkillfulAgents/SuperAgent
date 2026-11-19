import { genericOAuth, type GenericOAuthOptions } from 'better-auth/plugins/generic-oauth'

/** Discover a provider on its first use without blocking unrelated auth. */
export function lazyGenericOAuth<const ID extends string>(options: GenericOAuthOptions<ID>) {
  const plugin = genericOAuth(options)
  type PendingDiscovery = Awaited<ReturnType<typeof plugin.init>>['context']['genericOAuthPendingDiscovery']

  // Better Auth 1.7.12's normal init discovers every provider sequentially,
  // without a timeout. All auth endpoints await that shared initialization.
  // Seed its pending-provider map instead: the unchanged request hook performs
  // discovery only for the requested provider, shares concurrent attempts and
  // uses an abort signal that also bounds reading the response body to 10s.
  // This context shape is exported in 1.7.12's init return type; keep the exact
  // dependency pin and recovery/isolation tests when changing that contract.
  const init: typeof plugin.init = (context) => {
    const pending: PendingDiscovery = new Map(
      options.config.map((config) => [config.providerId, { config }]),
    )
    return Promise.resolve({
      context: {
        socialProviders: [...context.socialProviders],
        genericOAuthPendingDiscovery: pending,
      },
    })
  }

  return { ...plugin, init }
}
