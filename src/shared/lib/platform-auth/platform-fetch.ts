import type { z } from 'zod'

import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { captureException } from '@shared/lib/error-reporting'

/**
 * Raised when a request to the platform proxy fails. `status` is the HTTP
 * status the API route should surface; `message` is user-facing.
 */
export class PlatformRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PlatformRequestError'
  }
}

export function platformErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: { message?: unknown } }).error
  return typeof error?.message === 'string' && error.message.trim() ? error.message : null
}

interface FetchPlatformJsonOptions<T> {
  /** Proxy path, e.g. `/v1/account`. */
  path: string
  /** Bearer token to send. In a request scope the fetch interceptor overrides it. */
  token: string | null
  /** Zod schema validated at the boundary before the value is returned. */
  schema: z.ZodType<T>
  /** captureException tag, e.g. `platform-auth` / `platform-billing`. */
  area: string
  /** Maps a non-2xx HTTP status to a user-facing message + the status to surface. */
  mapStatusError: (status: number, body?: unknown) => { message: string; status: number }
  /** Message when there's no token (not connected). */
  notConnectedMessage?: string
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Shared boundary fetch for the platform proxy: resolves the base URL, sends the
 * bearer, maps non-2xx to a {@link PlatformRequestError}, and Zod-validates the
 * body. Callers supply only the path/schema and their status→message mapping.
 */
export async function fetchPlatformJson<T>(opts: FetchPlatformJsonOptions<T>): Promise<T> {
  const proxyBase = getPlatformProxyBaseUrl()
  if (!proxyBase) {
    throw new PlatformRequestError('Platform proxy is not configured.', 500)
  }
  if (!opts.token) {
    throw new PlatformRequestError(opts.notConnectedMessage ?? 'Platform is not connected.', 401)
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    ...opts.headers,
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${proxyBase}${opts.path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch (error) {
    captureException(error, { tags: { area: opts.area, op: 'fetch' } })
    throw new PlatformRequestError('Could not reach the platform. Please try again.', 502)
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const mapped = opts.mapStatusError(res.status, data)
    throw new PlatformRequestError(mapped.message, mapped.status)
  }

  const data = await res.json().catch(() => null)
  const parsed = opts.schema.safeParse(data)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: opts.area, op: 'parse' } })
    throw new PlatformRequestError('The platform returned an unexpected response.', 502)
  }
  return parsed.data
}
