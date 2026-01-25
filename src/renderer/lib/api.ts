import { getApiBaseUrl } from './env'

/**
 * Fetch wrapper that prepends the API base URL.
 * In web mode, this is empty (same-origin).
 * In Electron, this is http://localhost:{port} where port is dynamically assigned.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const baseUrl = getApiBaseUrl()
  return fetch(`${baseUrl}${path}`, init)
}
