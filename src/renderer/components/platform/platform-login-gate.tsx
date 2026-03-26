import { useEffect, useState } from 'react'
import { ArrowRight, KeyRound, Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@renderer/components/ui/card'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import {
  PLATFORM_AUTH_CHOICE_STORAGE_KEY,
  useApplyPlatformDefaults,
  useInitiatePlatformLogin,
  usePlatformAuthCallbackListener,
  usePlatformAuthStatus,
} from '@renderer/hooks/use-platform-auth'

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading platform connection...</div>
    </div>
  )
}

export function PlatformLoginGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = usePlatformAuthStatus()
  const applyPlatformDefaults = useApplyPlatformDefaults()
  const initiateLogin = useInitiatePlatformLogin()
  const [authChoice, setAuthChoice] = useState<'platform' | 'byok' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLaunching, setIsLaunching] = useState(false)

  useEffect(() => {
    const storedChoice = window.localStorage.getItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY)
    if (storedChoice) {
      setAuthChoice(storedChoice as 'platform' | 'byok')
      return
    }
    setAuthChoice(null)
  }, [])

  usePlatformAuthCallbackListener((params) => {
    setIsLaunching(false)
    if (params.success) {
      window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'platform')
      setAuthChoice('platform')
      setError(null)
      void applyPlatformDefaults().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to apply platform defaults.')
      })
      return
    }
    setError(params.error || 'Platform login failed.')
  })

  const shouldShowChoice = !data?.connected && authChoice !== 'byok'

  if (isLoading) {
    return <LoadingScreen />
  }

  async function handlePlatformLogin() {
    const popup = prepareOAuthPopup()
    setError(null)
    setIsLaunching(true)

    try {
      const result = await initiateLogin.mutateAsync()
      await popup.navigate(result.loginUrl)
    } catch (err) {
      popup.close()
      setIsLaunching(false)
      setError(err instanceof Error ? err.message : 'Failed to open Datawizz Platform login.')
    }
  }

  function handleBringYourOwnKey() {
    window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'byok')
    setAuthChoice('byok')
    setError(null)
  }

  if (shouldShowChoice) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
        <Card className="w-full max-w-xl border-border/70 shadow-lg">
          <CardHeader className="space-y-3 text-center">
            <CardTitle className="text-3xl">Choose how to get started</CardTitle>
            <CardDescription className="mx-auto max-w-md text-sm">
              Start with your own provider key, or log in to subscribe through Datawizz Platform.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <button
              type="button"
              onClick={() => {
                void handlePlatformLogin()
              }}
              className="w-full rounded-2xl border border-border/70 bg-card p-5 text-left transition-colors hover:bg-accent/40"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-base font-medium">Login to Subscribe</p>
                  <p className="text-sm text-muted-foreground">
                    Sign in with Datawizz Platform in your browser, then come right back automatically.
                  </p>
                </div>
                {isLaunching || initiateLogin.isPending ? (
                  <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <ArrowRight className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                )}
              </div>
            </button>

            <button
              type="button"
              onClick={handleBringYourOwnKey}
              className="w-full rounded-2xl border border-border/70 bg-card p-5 text-left transition-colors hover:bg-accent/40"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-base font-medium">Bring My Own Key</p>
                  <p className="text-sm text-muted-foreground">
                    Skip platform login for now and configure your own providers inside SuperAgent.
                  </p>
                </div>
                <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              </div>
            </button>

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="pt-2 text-center text-xs text-muted-foreground">
              You can always connect or disconnect Datawizz Platform later from the app settings.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
