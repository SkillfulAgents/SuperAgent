import { useMemo, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, LogIn, RefreshCw, Unplug } from 'lucide-react'

import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@renderer/components/ui/card'
import { Separator } from '@renderer/components/ui/separator'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import {
  useDisconnectPlatformAuth,
  useInitiatePlatformLogin,
  usePlatformAuthCallbackListener,
  usePlatformAuthStatus,
} from '@renderer/hooks/use-platform-auth'

type PlatformConnectCardProps = {
  mode?: 'gate' | 'settings'
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not connected yet'
  }

  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function PlatformConnectCard({ mode = 'settings' }: PlatformConnectCardProps) {
  const { data, isLoading } = usePlatformAuthStatus()
  const initiateLogin = useInitiatePlatformLogin()
  const disconnect = useDisconnectPlatformAuth()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLaunching, setIsLaunching] = useState(false)

  usePlatformAuthCallbackListener((params) => {
    setIsLaunching(false)
    if (params.success) {
      setError(null)
      setMessage(null)
      return
    }
    setMessage(null)
    setError(params.error || 'Platform login failed.')
  })

  const isConnected = !!data?.connected
  const title = mode === 'gate' ? 'Connect Datawizz Platform' : 'Datawizz Platform Account'
  const description = mode === 'gate'
    ? 'Sign in through the browser so SuperAgent can receive its platform token automatically.'
    : 'Manage the local platform token used by SuperAgent.'

  const connectLabel = useMemo(() => {
    if (isLaunching || initiateLogin.isPending) {
      return 'Opening browser...'
    }
    return isConnected ? 'Reconnect' : 'Connect Platform'
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

  async function handleDisconnect() {
    setMessage(null)
    setError(null)
    try {
      await disconnect.mutateAsync()
      setMessage('Disconnected from Datawizz Platform.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect platform auth.')
    }
  }

  async function handleOpenPlatformHome() {
    if (!data?.platformBaseUrl) {
      return
    }

    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(data.platformBaseUrl)
      return
    }

    window.open(data.platformBaseUrl, '_blank', 'noopener,noreferrer')
  }

  if (isLoading) {
    return (
      <Card className={mode === 'gate' ? 'w-full max-w-xl' : undefined}>
        <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading platform status...</span>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={mode === 'gate' ? 'w-full max-w-xl shadow-lg' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <CheckCircle2 className={`h-5 w-5 ${isConnected ? 'text-primary' : 'text-muted-foreground'}`} />
          <span>{title}</span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/20 p-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Status</span>
            <span className={isConnected ? 'font-medium text-foreground' : 'text-muted-foreground'}>
              {isConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>

          <Separator className="my-3" />

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Platform URL</span>
              <span className="max-w-[70%] truncate font-mono text-xs">{data?.platformBaseUrl}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Account</span>
              <span className="max-w-[70%] truncate">{data?.email ?? 'Not connected'}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Token</span>
              <span className="font-mono text-xs">{data?.tokenPreview ?? 'No token stored'}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Last updated</span>
              <span className="text-right">{formatTimestamp(data?.updatedAt ?? null)}</span>
            </div>
          </div>
        </div>

        {message ? (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
              {error.includes('membership') ? ' Create or join an organization in Datawizz Platform, then try again.' : ''}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        <Button onClick={handleConnect} disabled={isLaunching || initiateLogin.isPending}>
          {isLaunching || initiateLogin.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : isConnected ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <LogIn className="mr-2 h-4 w-4" />
          )}
          {connectLabel}
        </Button>

        <Button
          variant="outline"
          onClick={() => {
            void handleOpenPlatformHome()
          }}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Open Platform
        </Button>

        {isConnected ? (
          <Button
            variant="ghost"
            onClick={handleDisconnect}
            disabled={disconnect.isPending}
          >
            {disconnect.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Unplug className="mr-2 h-4 w-4" />
            )}
            Disconnect
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  )
}
