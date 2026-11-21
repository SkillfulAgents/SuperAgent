import { genericOAuth, type GenericOAuthOptions } from 'better-auth/plugins/generic-oauth'

/** Discover a provider on its first use without blocking unrelated auth. */
export function lazyGenericOAuth<const ID extends string>(options: GenericOAuthOptions<ID>) {
  const plugin = genericOAuth(options)
  type PendingDiscovery = Awaited<ReturnType<typeof plugin.init>>['context']['genericOAuthPendingDiscovery']
  type RetryHook = (typeof plugin.hooks.before)[number]

  // Better Auth 1.7.27's normal init discovers every provider sequentially,
  // without a timeout. All auth endpoints await that shared initialization.
  // Seed its pending-provider map instead: upstream's request hook (wrapped
  // below only to share attempts) performs discovery only for the requested
  // provider and uses an abort signal that also bounds reading the response
  // body to 10s.
  // This context shape is exported in 1.7.27's init return type; keep the exact
  // dependency pin and recovery/isolation tests when changing that contract.
  const init: typeof plugin.init = (context) => {
    const pending: PendingDiscovery = new Map(
      options.config.map((config) => [config.providerId, config]),
    )
    return Promise.resolve({
      context: {
        socialProviders: [...context.socialProviders],
        genericOAuthPendingDiscovery: pending,
      },
    })
  }

  // Up to 1.7.12 the request hook shared one discovery attempt between
  // concurrent requests for the same provider; 1.7.27 starts one per request.
  // Keep sharing it, so a stalled provider sees one discovery request at a
  // time per auth instance, not one per sign-in click. Attempts are keyed by
  // the instance's pending map, then by provider id read the way the hook
  // reads it.
  //
  // Runtime caveat: a request joining an attempt awaits a fetch that belongs
  // to another request. That is right on Node and Electron. On a runtime where
  // one request cannot await another's I/O (Cloudflare Workers: upstream turns
  // its own shared lookups off there, `sharesLookups = !isWorkerd()`), this
  // sharing must be skipped and every request fall through to upstream's hook.
  //
  // The casts below bridge a plain function to better-call's Middleware type
  // and read upstream's context field; the exact version pin and the
  // discovery-timeout/isolation tests are what guard that coupling.
  const attempts = new WeakMap<PendingDiscovery, Map<string, Promise<unknown>>>()
  const shareAttempts = (hook: RetryHook): RetryHook => {
    const handler = ((input: Parameters<RetryHook['matcher']>[0]) => {
      const pending = (input.context as { genericOAuthPendingDiscovery?: PendingDiscovery }).genericOAuthPendingDiscovery
      const id: unknown = input.body?.provider ?? input.body?.providerId ?? input.query?.provider ?? input.params?.id
      if (!pending || typeof id !== 'string' || !pending.has(id)) return hook.handler(input as never)
      let inFlight = attempts.get(pending)
      if (!inFlight) attempts.set(pending, inFlight = new Map())
      const existing = inFlight.get(id)
      if (existing) {
        // Upstream's hook only rediscovers the provider and sets no headers or
        // cookies; each request's own endpoint sets its state cookie, PKCE
        // verifier and nonce afterwards. A joiner needs only the outcome.
        return existing.then(() => undefined)
      }
      const byId = inFlight
      const attempt = Promise.resolve(hook.handler(input as never)).finally(() => byId.delete(id))
      inFlight.set(id, attempt)
      return attempt
    }) as unknown as RetryHook['handler']
    return { ...hook, handler }
  }

  return { ...plugin, init, hooks: { ...plugin.hooks, before: plugin.hooks.before.map(shareAttempts) } }
}
