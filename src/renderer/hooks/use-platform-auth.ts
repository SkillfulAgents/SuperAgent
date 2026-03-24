import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'

export interface PlatformAuthStatus {
  connected: boolean
  tokenPreview: string | null
  email: string | null
  label: string | null
  orgName: string | null
  role: string | null
  createdAt: string | null
  updatedAt: string | null
  platformBaseUrl: string
}

export interface PlatformAuthCallbackParams {
  success: boolean
  email?: string | null
  error?: string | null
}

export function usePlatformAuthStatus() {
  return useQuery<PlatformAuthStatus>({
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
}

export function useInitiatePlatformLogin() {
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

export function useDisconnectPlatformAuth() {
  const queryClient = useQueryClient()

  return useMutation<PlatformAuthStatus, Error>({
    mutationFn: async () => {
      const res = await apiFetch('/api/platform-auth', {
        method: 'DELETE',
      })
      if (!res.ok) {
        const error = await res.json().catch(() => ({}))
        throw new Error(error.error || 'Failed to disconnect platform auth')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-auth'] })
    },
  })
}

export function usePlatformAuthCallbackListener(
  onCallback?: (params: PlatformAuthCallbackParams) => void
) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!window.electronAPI?.onPlatformAuthCallback) {
      return
    }

    const handleCallback = (params: PlatformAuthCallbackParams) => {
      queryClient.invalidateQueries({ queryKey: ['platform-auth'] })
      onCallback?.(params)
    }

    window.electronAPI.onPlatformAuthCallback(handleCallback)
    return () => {
      window.electronAPI?.removePlatformAuthCallback?.()
    }
  }, [onCallback, queryClient])
}
