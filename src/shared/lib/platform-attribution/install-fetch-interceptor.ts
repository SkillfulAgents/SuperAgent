import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'

import { attribution } from './index'

/** Wrap `globalThis.fetch` so platform-proxy requests pick up active attribution from ALS. Idempotent. */

let installed = false
let realFetch: typeof globalThis.fetch | null = null

export function installPlatformFetchInterceptor(): void {
  if (installed) return
  installed = true
  realFetch = globalThis.fetch.bind(globalThis)

  const debug = process.env.DEBUG_PLATFORM_API === '1'

  globalThis.fetch = async function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    const proxyBase = getPlatformProxyBaseUrl()
    if (proxyBase && url.startsWith(proxyBase)) {
      const headers = new Headers(init?.headers)
      attribution.current()?.applyTo(headers)
      if (debug) {
        const t0 = Date.now()
        const method = init?.method ?? 'GET'
        const res = await realFetch!(input, { ...init, headers })
        console.log(
          `[platform-fetch] ${method} ${url} -> ${res.status} (${Date.now() - t0}ms)`
        )
        return res
      }
      return realFetch!(input, { ...init, headers })
    }

    return realFetch!(input, init)
  } as typeof fetch
}

/** Test-only: undo the interceptor and reset its singleton state. */
export function _uninstallPlatformFetchInterceptorForTest(): void {
  if (!installed) return
  if (realFetch) globalThis.fetch = realFetch
  installed = false
  realFetch = null
}
