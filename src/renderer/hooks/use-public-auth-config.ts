import { useEffect, useState } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'

export interface PublicAuthConfig {
  allowLocalAuth: boolean
}

const DEFAULT_PUBLIC_AUTH_CONFIG: PublicAuthConfig = {
  allowLocalAuth: true,
}

/** Public `/api/auth-config` — readable by non-admins (unlike `/api/settings`). */
export function usePublicAuthConfig(): {
  config: PublicAuthConfig
  isLoading: boolean
} {
  const [config, setConfig] = useState<PublicAuthConfig>(DEFAULT_PUBLIC_AUTH_CONFIG)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/auth-config')
      .then(async (res) => {
        if (!res.ok) throw new Error(`auth-config ${res.status}`)
        return res.json() as Promise<{ allowLocalAuth?: boolean }>
      })
      .then((data) => {
        if (cancelled) return
        setConfig({
          allowLocalAuth: data.allowLocalAuth ?? true,
        })
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('Failed to load public auth config', error)
        captureRendererException(error, {
          tags: { area: 'auth-config', op: 'use-public-auth-config' },
        })
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { config, isLoading }
}
