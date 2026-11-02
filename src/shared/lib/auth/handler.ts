import { getAuth } from './index'
import { runAuthRequest } from './platform-role'

/**
 * Keep the callback URL registered by existing deployments and identity
 * providers. Better Auth 1.7 handles generic OIDC on the core social callback;
 * provider-config pins redirectURI to the registered URL for both halves of
 * the code exchange. Rewrite internally so query, form body and cookies survive
 * without a browser redirect or a coordinated identity-provider rollout.
 *
 * Call this only behind the normal /api/auth middleware stack.
 */
export function handleAuthRequest(request: Request): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- Request construction already validates its absolute URL.
  const url = new URL(request.url)
  const legacyCallback = /^\/api\/auth\/oauth2\/callback\/([^/]+)$/.exec(url.pathname)
  if (legacyCallback && (request.method === 'GET' || request.method === 'POST')) {
    url.pathname = `/api/auth/callback/${legacyCallback[1]}`
    request = new Request(url, request)
  }
  return runAuthRequest(() => getAuth().handler(request))
}
