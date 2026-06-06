import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import { useUpdateSettings } from '@renderer/hooks/use-settings'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import type {
  PlatformAuthSource,
  PlatformAuthStatus as SharedPlatformAuthStatus,
} from '@shared/lib/services/platform-auth-service'

export const PLATFORM_AUTH_CHOICE_STORAGE_KEY = 'superagent-auth-choice'

export type { PlatformAuthSource }

export interface PlatformAuthStatus extends SharedPlatformAuthStatus {
  platformBaseUrl: string
}

export interface PlatformAuthCallbackParams {
  success: boolean
  email?: string | null
  error?: string | null
}

// Run env-managed auto-sync at most once per process.
let envSkillsetSyncFired = false

function triggerPlatformSkillsetSync(queryClient: QueryClient): void {
  void apiFetch('/api/skillsets/sync-remote', {
    method: 'POST',
    body: JSON.stringify({ provider: 'platform' }),
  })
    .then(() => queryClient.invalidateQueries({ queryKey: ['skillsets'] }))
    .catch(() => {})
}

export function usePlatformAuthStatus() {
  const queryClient = useQueryClient()
  const query = useQuery<PlatformAuthStatus>({
    queryKey: ['platform-auth'],
    queryFn: async () => {
      const res = await apiFetch('/api/platform-auth')
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || 'Failed to fetch platform auth status')
      }
      return res.json()
    },
  })

  // AUTH_MODE skips OAuth complete; mirror auto-sync once on first connect.
  useEffect(() => {
    if (envSkillsetSyncFired) return
    const status = query.data
    if (!status?.connected || status.source !== 'env') return
    envSkillsetSyncFired = true
    triggerPlatformSkillsetSync(queryClient)
  }, [query.data, queryClient])

  return query
}

function useInitiatePlatformLogin() {
  return useMutation<{ loginUrl: string; platformBaseUrl: string }, Error>({
    mutationFn: async () => {
      const res = await apiFetch('/api/platform-auth/initiate', {
        method: 'POST',
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || 'Failed to start platform login')
      }
      return res.json()
    },
  })
}

function useRevokePlatformToken() {
  return useMutation<{ success: boolean }, Error, { clearLocal?: boolean } | undefined>({
    mutationFn: async (options) => {
      const res = await apiFetch('/api/platform-auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options ?? {}),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || 'Failed to revoke platform token')
      }
      return res.json()
    },
  })
}

function usePlatformAuthCallbackListener(
  onCallback?: (params: PlatformAuthCallbackParams) => void
) {
  const queryClient = useQueryClient()
  const callbackRef = useRef(onCallback)
  callbackRef.current = onCallback

  useEffect(() => {
    if (!window.electronAPI?.onPlatformAuthCallback) {
      return
    }

    const handleCallback = (params: PlatformAuthCallbackParams) => {
      queryClient.invalidateQueries({ queryKey: ['platform-auth'] })
      callbackRef.current?.(params)
    }

    const unsubscribe = window.electronAPI.onPlatformAuthCallback(handleCallback)
    return () => {
      unsubscribe?.()
    }
  }, [queryClient])
}

function useApplyPlatformDefaults() {
  const updateSettings = useUpdateSettings()

  return useCallback(async () => {
    await updateSettings.mutateAsync({
      llmProvider: 'platform',
      voice: {
        sttProvider: 'platform',
      },
    })
  }, [updateSettings])
}

export interface PlatformConnectOptions {
  onSuccess?: (params: PlatformAuthCallbackParams) => void
  successMessage?: string | ((wasConnected: boolean) => string | null) | null
}

export function useSavePlatformAccessKey() {
  const queryClient = useQueryClient()
  const applyPlatformDefaults = useApplyPlatformDefaults()

  return useMutation<unknown, Error, string>({
    mutationFn: async (token: string) => {
      const res = await apiFetch('/api/platform-auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save access key')
      }
      return res.json()
    },
    onSuccess: async () => {
      window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'platform')
      queryClient.invalidateQueries({ queryKey: ['platform-auth'] })
      await applyPlatformDefaults().catch(() => {})

      triggerPlatformSkillsetSync(queryClient)
    },
  })
}

export function usePlatformConnect(options?: PlatformConnectOptions) {
  const queryClient = useQueryClient()
  const platformAuthQuery = usePlatformAuthStatus()
  const platformAuth = platformAuthQuery.data
  const applyPlatformDefaults = useApplyPlatformDefaults()
  const initiateLogin = useInitiatePlatformLogin()
  const revokePlatformToken = useRevokePlatformToken()
  const [isLaunching, setIsLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const wasConnected = !!platformAuth?.connected

  const onSuccessRef = useRef(options?.onSuccess)
  onSuccessRef.current = options?.onSuccess
  const successMessageRef = useRef(options?.successMessage)
  successMessageRef.current = options?.successMessage

  usePlatformAuthCallbackListener((params) => {
    setIsLaunching(false)
    if (params.success) {
      window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'platform')
      setError(null)
      const successMessage = successMessageRef.current
      setMessage(
        typeof successMessage === 'function'
          ? successMessage(wasConnected)
          : successMessage === undefined
            ? (wasConnected ? 'Platform reconnected successfully.' : 'Platform connected successfully.')
            : successMessage
      )
      void applyPlatformDefaults().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to apply platform defaults.')
      })

      triggerPlatformSkillsetSync(queryClient)

      onSuccessRef.current?.(params)
      return
    }
    setMessage(null)
    setError(params.error || 'Platform login failed.')
  })

  const handleConnect = useCallback(async () => {
    const popup = prepareOAuthPopup()
    setError(null)
    setMessage(null)
    setIsLaunching(true)

    try {
      if (wasConnected) {
        await revokePlatformToken.mutateAsync({ clearLocal: false }).catch(() => ({ success: false }))
      }
      const result = await initiateLogin.mutateAsync()
      await popup.navigate(result.loginUrl)
    } catch (err) {
      popup.close()
      setIsLaunching(false)
      setError(err instanceof Error ? err.message : 'Failed to open platform login.')
    }
  }, [initiateLogin, revokePlatformToken, wasConnected])

  return {
    handleConnect,
    isLaunching: isLaunching || initiateLogin.isPending,
    error,
    message,
    isConnected: !!platformAuth?.connected,
    platformAuth,
    isLoadingPlatformAuth: platformAuthQuery.isLoading,
  }
}
