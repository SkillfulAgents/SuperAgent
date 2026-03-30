import { useMemo, useState } from 'react'
import { ExternalLink, Loader2, LogIn, RefreshCw } from 'lucide-react'

import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import {
  PLATFORM_AUTH_CHOICE_STORAGE_KEY,
  useApplyPlatformDefaults,
  useInitiatePlatformLogin,
  usePlatformAuthCallbackListener,
  usePlatformAuthStatus,
} from '@renderer/hooks/use-platform-auth'

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function PlatformTab() {
  const { data, isLoading } = usePlatformAuthStatus()
  const applyPlatformDefaults = useApplyPlatformDefaults()
  const initiateLogin = useInitiatePlatformLogin()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLaunching, setIsLaunching] = useState(false)

  usePlatformAuthCallbackListener((params) => {
    setIsLaunching(false)
    if (params.success) {
      window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'platform')
      setError(null)
      setMessage('Connected. Please restart your running agents for the new token to take effect.')
      void applyPlatformDefaults().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to apply platform defaults.')
      })
      return
    }
    setMessage(null)
    setError(params.error || 'Platform login failed.')
  })

  const isConnected = !!data?.connected

  const connectLabel = useMemo(() => {
    if (isLaunching || initiateLogin.isPending) return 'Opening browser…'
    return isConnected ? 'Reconnect' : 'Connect'
  }, [initiateLogin.isPending, isConnected, isLaunching])

  async function handleConnect() {
    const popup = prepareOAuthPopup()
    setMessage(null)
    setError(null)
    setIsLaunching(true)
    try {
      const result = await initiateLogin.mutateAsync()
      await popup.navigate(result.loginUrl)
    } catch (err) {
      popup.close()
      setIsLaunching(false)
      setError(err instanceof Error ? err.message : 'Failed to open platform login.')
    }
  }

  async function handleOpenPlatform() {
    if (!data?.platformBaseUrl) return
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(data.platformBaseUrl)
      return
    }
    window.open(data.platformBaseUrl, '_blank', 'noopener,noreferrer')
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading platform status…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="space-y-2">
        <Label>Status</Label>
        <p className={`text-sm ${isConnected ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
          {isConnected ? 'Connected' : 'Not connected'}
        </p>
      </div>

      {/* Account */}
      <div className="space-y-2">
        <Label>Account</Label>
        <p className="text-sm">{data?.email ?? '—'}</p>
      </div>

      {/* Organization */}
      <div className="space-y-2">
        <Label>Organization</Label>
        <p className="text-sm">{data?.orgName ?? '—'}</p>
      </div>

      {/* Role */}
      <div className="space-y-2">
        <Label>Role</Label>
        <p className="text-sm capitalize">{data?.role ?? '—'}</p>
      </div>

      {/* Last updated */}
      <div className="space-y-2">
        <Label>Last updated</Label>
        <p className="text-sm">{formatTimestamp(data?.updatedAt ?? null)}</p>
      </div>

      {/* Feedback */}
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            {error.includes('membership') ? ' Create or join an organization in Platform, then try again.' : ''}
          </AlertDescription>
        </Alert>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-2">
        <Button size="sm" onClick={handleConnect} disabled={isLaunching || initiateLogin.isPending}>
          {isLaunching || initiateLogin.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : isConnected ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <LogIn className="mr-2 h-4 w-4" />
          )}
          {connectLabel}
        </Button>

        <Button size="sm" variant="outline" onClick={() => { void handleOpenPlatform() }}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open Platform
        </Button>

      </div>
    </div>
  )
}
