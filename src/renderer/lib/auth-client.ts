import { createAuthClient } from 'better-auth/react'
import { adminClient, genericOAuthClient } from 'better-auth/client/plugins'
import { getApiBaseUrl } from './env'

/**
 * The Better Auth client, pointed at whichever API this renderer drives.
 *
 * **Built on first use, not at import.** Its `baseURL` has to be the same base
 * every other call site prefixes, and in cloud mode that is the keyed proxy
 * prefix, which the main process only reveals during `initApiBaseUrl()`. This
 * module is imported (via `user-context`) while the module graph is still
 * evaluating — before that runs — so a client constructed at import time would
 * permanently point at the local API and every session lookup in cloud mode
 * would resolve against the wrong Superagent.
 *
 * Deferring to first use costs one `??=` and keeps every consumer unchanged.
 */

function resolveBaseUrl(): string | undefined {
  const base = getApiBaseUrl()
  // Electron: the local API's port, or the cloud proxy prefix.
  if (base) return base
  // Web: same-origin, which better-auth expresses as no baseURL at all. The
  // `file://` case cannot reach here (Electron always has a base URL by now),
  // but better-auth rejects that origin outright, so keep the dummy for a
  // renderer that somehow initializes without one.
  return typeof window !== 'undefined' && window.location.protocol === 'file:'
    ? 'http://localhost'
    : undefined
}

type AuthClient = ReturnType<typeof buildClient>

function buildClient() {
  return createAuthClient({
    baseURL: resolveBaseUrl(),
    plugins: [adminClient(), genericOAuthClient()],
  })
}

let client: AuthClient | null = null

function getClient(): AuthClient {
  client ??= buildClient()
  return client
}

/** Test seam: drops the built client so the next use re-reads the base URL. */
export function _resetAuthClientForTest(): void {
  client = null
}

// Forwarding proxy rather than a re-export, so `authClient.admin.listUsers(…)`
// and friends keep working untouched while construction stays deferred.
export const authClient = new Proxy({} as AuthClient, {
  get: (_target, prop) => Reflect.get(getClient(), prop),
}) as AuthClient

export const signIn = new Proxy({} as AuthClient['signIn'], {
  get: (_target, prop) => Reflect.get(getClient().signIn, prop),
}) as AuthClient['signIn']

export const signUp = new Proxy({} as AuthClient['signUp'], {
  get: (_target, prop) => Reflect.get(getClient().signUp, prop),
}) as AuthClient['signUp']

export const signOut: AuthClient['signOut'] = (...args) => getClient().signOut(...args)

export const useSession: AuthClient['useSession'] = (...args) => getClient().useSession(...args)
