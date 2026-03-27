import { useState } from 'react'
import { Loader2, LogIn, RefreshCw } from 'lucide-react'

import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import {
  PLATFORM_AUTH_CHOICE_STORAGE_KEY,
  useApplyPlatformDefaults,
  useInitiatePlatformLogin,
  usePlatformAuthCallbackListener,
  usePlatformAuthStatus,
} from '@renderer/hooks/use-platform-auth'

export function WelcomeStep() {
  const { data: platformAuth } = usePlatformAuthStatus()
  const applyPlatformDefaults = useApplyPlatformDefaults()
  const initiatePlatformLogin = useInitiatePlatformLogin()
  const [platformError, setPlatformError] = useState<string | null>(null)
  const [platformMessage, setPlatformMessage] = useState<string | null>(null)
  const [isLaunchingPlatformLogin, setIsLaunchingPlatformLogin] = useState(false)

  usePlatformAuthCallbackListener((params) => {
    setIsLaunchingPlatformLogin(false)
    if (params.success) {
      window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'platform')
      setPlatformError(null)
      setPlatformMessage(platformAuth?.connected
        ? 'Platform reconnected successfully.'
        : 'Platform connected successfully.')
      void applyPlatformDefaults().catch((err) => {
        setPlatformError(err instanceof Error ? err.message : 'Failed to apply platform defaults.')
      })
      return
    }
    setPlatformMessage(null)
    setPlatformError(params.error || 'Platform login failed.')
  })

  async function handlePlatformConnect() {
    const popup = prepareOAuthPopup()
    setPlatformError(null)
    setPlatformMessage(null)
    setIsLaunchingPlatformLogin(true)

    try {
      const result = await initiatePlatformLogin.mutateAsync()
      await popup.navigate(result.loginUrl)
    } catch (err) {
      popup.close()
      setIsLaunchingPlatformLogin(false)
      setPlatformError(err instanceof Error ? err.message : 'Failed to open platform login.')
    }
  }

  const isConnected = !!platformAuth?.connected

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Welcome to Superagent</h2>
        <p className="text-muted-foreground">
          Superagent lets you create and manage AI agents that run in isolated containers.
          Each agent has its own environment, tools, and can connect to external services.
        </p>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {isConnected ? 'Datawizz Platform Connected' : 'Login to Datawizz Platform'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {isConnected
              ? `Signed in as ${platformAuth?.email ?? 'your account'}. Re-login here if you want to refresh or switch accounts.`
              : 'Launch platform login right from the wizard, or skip it and continue with your own provider key.'}
          </p>
        </div>

        <Button
          type="button"
          variant={isConnected ? 'outline' : 'default'}
          onClick={() => {
            void handlePlatformConnect()
          }}
          disabled={isLaunchingPlatformLogin || initiatePlatformLogin.isPending}
          data-testid="wizard-platform-login"
        >
          {isLaunchingPlatformLogin || initiatePlatformLogin.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : isConnected ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <LogIn className="mr-2 h-4 w-4" />
          )}
          {isConnected ? 'Re-login to Platform' : 'Login to Subscribe'}
        </Button>

        {platformMessage ? (
          <Alert>
            <AlertDescription>{platformMessage}</AlertDescription>
          </Alert>
        ) : null}
        {platformError ? (
          <Alert variant="destructive">
            <AlertDescription>{platformError}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="space-y-3 pt-1">
        <p className="text-sm font-medium">This wizard will help you set up:</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">1.</span>
            <span><strong>Platform Login</strong> (optional) - Sign in or re-login to Datawizz Platform</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">2.</span>
            <span><strong>LLM Provider</strong> - Configure your AI model API key</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">3.</span>
            <span><strong>Browser</strong> (optional) - Choose how agents browse the web</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">4.</span>
            <span><strong>Composio</strong> (optional) - Connect OAuth accounts like Gmail, Slack, GitHub</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">5.</span>
            <span><strong>Container Runtime</strong> - Ensure containers can run on your machine</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">6.</span>
            <span><strong>First Agent</strong> (optional) - Create your first AI agent</span>
          </li>
        </ul>
      </div>

      <p className="text-sm text-muted-foreground pt-1">
        You can always change these settings later. Click <strong>Next</strong> to keep configuring the rest of your setup.
      </p>
    </div>
  )
}
