import { getApiBaseUrl } from './env'

/**
 * Fetch wrapper that prepends the API base URL.
 * In web mode, this is empty (same-origin).
 * In Electron, this is http://localhost:{port} where port is dynamically assigned.
 *
 * In auth mode, automatically signs out on 401 responses (expired session).
 */
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const baseUrl = getApiBaseUrl()
  const response = await fetch(`${baseUrl}${path}`, init)

  // Auto-sign-out on 401 in auth mode (skip auth endpoints to avoid loops)
  if (__AUTH_MODE__ && response.status === 401 && !path.startsWith('/api/auth/')) {
    const { signOut } = await import('./auth-client')
    await signOut().catch(() => {}) // session may already be gone
  }

  return response
}

/**
 * Thrown by `apiJson` on a non-2xx response, carrying the HTTP status so route
 * loaders can map it: 403/404 → `notFound()`, 5xx/network → `errorComponent`
 * (migration plan §9.2).
 */
export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
  }
}

/**
 * Loader-only fetch: returns parsed JSON, throwing `HttpError` on a non-2xx
 * response. The existing data hooks stay on `apiFetch` (which never throws and
 * renders its own inline loading/empty states); loaders need a throw to gate
 * access before the route renders.
 */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw new HttpError(res.status)
  return res.json() as Promise<T>
}
