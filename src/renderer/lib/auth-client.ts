import { createAuthClient } from 'better-auth/react'
import { adminClient, genericOAuthClient } from 'better-auth/client/plugins'
import { getApiBaseUrl } from './env'
import { targetIsRemote } from './api-target'

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
  //
  // `/api/auth` is appended HERE rather than left to better-auth, because
  // better-auth only appends its default path to a base URL that has no path of
  // its own (`withPath` returns the URL verbatim once `checkHasPath` is true).
  // A local base is bare origin, so it used to get the default for free — but a
  // cloud base is `http://localhost:{port}/cloud/{key}`, which *has* a path, so
  // every call landed on `/cloud/{key}/get-session` and 404'd. That reads as a
  // dead session rather than a broken URL: `useSession()` resolves to null,
  // `isAuthenticated` goes false, and `AuthGate` shows "can't reach your cloud
  // workspace" against a workspace that is answering perfectly well.
  //
  // Appending it ourselves is a no-op for the local and web cases (the result
  // already has a path, so better-auth passes it through unchanged) and the
  // whole fix for the cloud one.
  if (base) return `${base}/api/auth`
  // Web: same-origin, which better-auth expresses as no baseURL at all. The
  // `file://` case cannot reach here (Electron always has a base URL by now),
  // but better-auth rejects that origin outright, so keep the dummy for a
  // renderer that somehow initializes without one.
  return typeof window !== 'undefined' && window.location.protocol === 'file:'
    ? 'http://localhost'
    : undefined
}

/**
 * Whether to attach the renderer's own credentials to auth calls.
 *
 * Cloud mode is the one target where they are pure cost. The session belongs to
 * the *deployment*, and the renderer never holds it: `cloud-proxy.ts` drops any
 * inbound `Authorization` and injects the deployment token from the main
 * process, and no cookie of this renderer's is scoped to the deployment's
 * origin anyway. So `include` sends nothing usable — and makes the request
 * credentialed, which forbids the local API's wildcard `Access-Control-Allow-
 * Origin` and gets `get-session` blocked before it is ever sent.
 *
 * That only bites where the renderer has a real HTTP origin — `electron-vite
 * dev` serves it from `http://localhost:5173`, while a packaged renderer is
 * `file://` and is not subject to it. The symptom is the reconnect screen over
 * a workspace that is answering perfectly well, so cloud mode looks broken in
 * dev and healthy once packaged.
 *
 * Local and web keep `include`: their session IS a cookie on the API's origin.
 */
function credentialsMode(): RequestCredentials {
  return targetIsRemote() ? 'omit' : 'include'
}

type AuthClient = ReturnType<typeof buildClient>

function buildClient() {
  return createAuthClient({
    baseURL: resolveBaseUrl(),
    fetchOptions: { credentials: credentialsMode() },
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
