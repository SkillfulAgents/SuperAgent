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
