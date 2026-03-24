import { useEffect, useState } from 'react'
import { ArrowRight, KeyRound, Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@renderer/components/ui/card'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import {
  useInitiatePlatformLogin,
  usePlatformAuthCallbackListener,
  usePlatformAuthStatus,
} from '@renderer/hooks/use-platform-auth'

const AUTH_CHOICE_STORAGE_KEY = 'superagent-auth-choice'

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading platform connection...</div>
    </div>
  )
}

export function PlatformLoginGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = usePlatformAuthStatus()
  const initiateLogin = useInitiatePlatformLogin()
  const [authChoice, setAuthChoice] = useState<'platform' | 'byok' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLaunching, setIsLaunching] = useState(false)

  useEffect(() => {
    const storedChoice = window.localStorage.getItem(AUTH_CHOICE_STORAGE_KEY)
    if (storedChoice === 'byok') {
      setAuthChoice('byok')
      return
    }
    setAuthChoice('platform')
  }, [])

  usePlatformAuthCallbackListener((params) => {
    setIsLaunching(false)
    if (params.success) {
      setError(null)
      return
    }
    setError(params.error || 'Platform login failed.')
  })

  if (isLoading || authChoice === null) {
    return <LoadingScreen />
  }

  if (!data?.connected && authChoice !== 'byok') {
    async function handlePlatformLogin() {
      const popup = prepareOAuthPopup()
      setError(null)
      setIsLaunching(true)

      try {
        window.localStorage.setItem(AUTH_CHOICE_STORAGE_KEY, 'platform')
        setAuthChoice('platform')
        const result = await initiateLogin.mutateAsync()
        await popup.navigate(result.loginUrl)
      } catch (err) {
        popup.close()
        setIsLaunching(false)
        setError(err instanceof Error ? err.message : 'Failed to open Datawizz Platform login.')
      }
    }

    function handleBringYourOwnKey() {
      window.localStorage.setItem(AUTH_CHOICE_STORAGE_KEY, 'byok')
      setAuthChoice('byok')
      setError(null)
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
        <Card className="w-full max-w-xl border-border/70 shadow-lg">
          <CardHeader className="space-y-3 text-center">
            <CardTitle className="text-3xl">Sign in to use SuperAgent</CardTitle>
            <CardDescription className="mx-auto max-w-md text-sm">
              Use Datawizz Platform for the best experience, or bring your own key to get started locally.
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
                  <p className="text-base font-medium">Continue with Datawizz Platform</p>
                  <p className="text-sm text-muted-foreground">
                    Sign in in your browser, then come right back to SuperAgent automatically.
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
                  <p className="text-base font-medium">Bring your own key</p>
                  <p className="text-sm text-muted-foreground">
                    Skip platform sign-in for now and continue into setup with your own provider key.
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
