/**
 * Outbound fetch for remote-MCP / OAuth URLs: resolve+validate, pin the
 * socket to a vetted address, and follow redirects only after the same
 * check on every Location hop.
 */

import { Agent } from 'undici'
import { resolveMcpDiscoveryTarget, tryParseUrl } from '@shared/lib/utils/url-safety'

const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

type FetchWithDispatcher = (
  input: string,
  init?: RequestInit & { dispatcher?: Agent },
) => Promise<Response>

/** Match fetch redirect:follow method rewriting for 301/302/303. */
function initForRedirect(status: number, init?: RequestInit): RequestInit | undefined {
  if (!init) return init
  const method = (init.method ?? 'GET').toUpperCase()
  if (
    status === 303 ||
    ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')
  ) {
    return { ...init, method: 'GET', body: undefined }
  }
  return init
}

/** Fetch strips these on cross-origin redirects; our manual loop must too. */
function stripSensitiveHeaders(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) return init
  const headers = new Headers(init.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  return { ...init, headers }
}

async function pinnedFetch(url: string, init?: RequestInit): Promise<Response> {
  const { addresses } = await resolveMcpDiscoveryTarget(url)
  const pinned = addresses[0]

  const agent = new Agent({
    connect: {
      lookup(_hostname, _options, callback) {
        // undici 7 invokes lookup with `{ all: true }` and expects an address
        // list; the Node dns `(err, address, family)` shape yields undefined IP.
        callback(null, [{ address: pinned.address, family: pinned.family }])
      },
    },
  })

  try {
    return await (fetch as FetchWithDispatcher)(url, {
      ...init,
      dispatcher: agent,
      redirect: 'manual',
    })
  } finally {
    void agent.close()
  }
}

export async function mcpSafeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let currentUrl = url
  let currentInit = init
  let response = await pinnedFetch(currentUrl, currentInit)
  let redirects = 0

  while (REDIRECT_STATUS.has(response.status) && redirects < MAX_REDIRECTS) {
    const location = response.headers.get('location')
    if (!location) break

    const next = tryParseUrl(location, currentUrl)
    const current = tryParseUrl(currentUrl)
    if (!next || !current) {
      throw new Error(`Invalid redirect Location: ${location}`)
    }

    const crossOrigin = next.origin !== current.origin
    currentInit = initForRedirect(response.status, currentInit)
    if (crossOrigin) {
      currentInit = stripSensitiveHeaders(currentInit)
      // 307/308 keep the body; do not replay secrets onto a new origin.
      if (
        (response.status === 307 || response.status === 308) &&
        currentInit?.body != null
      ) {
        break
      }
    }

    currentUrl = next.href
    response = await pinnedFetch(currentUrl, currentInit)
    redirects++
  }

  return response
}
