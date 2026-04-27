import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { RequestError } from '@renderer/components/messages/request-error'
import { ManualAccessKeyInput } from '@renderer/components/settings/manual-access-key-input'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformConnect } from '@renderer/hooks/use-platform-auth'

interface WelcomeStepProps {
  onChoosePlatform?: () => void
  onContinueToManualSetup?: () => void
}

export function WelcomeStep({ onChoosePlatform, onContinueToManualSetup }: WelcomeStepProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const {
    handleConnect,
    isLaunching,
    error: platformError,
  } = usePlatformConnect({
    successMessage: null,
    onSuccess: () => {
      onChoosePlatform?.()
    },
  })

  async function handleManualSetup() {
    try {
      if (settings?.llmProvider === 'platform') {
        await updateSettings.mutateAsync({ llmProvider: 'anthropic' })
      }
      onContinueToManualSetup?.()
    } catch {
      // Keep the original wizard flow simple: if switching providers fails,
      // stay on this step and let the existing settings UI handle recovery.
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h2 className="text-4xl font-normal">Build your<br />agent workforce</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          Superagent is the most powerful and secure way to build and manage AI teammates that actually get the job done.
        </p>
      </div>

      <div className="flex flex-col gap-8">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="default"
              size="lg"
              onClick={() => void handleConnect()}
              data-testid="wizard-platform-login"
              disabled={isLaunching}
              className="w-full max-w-[380px]"
            >
              {isLaunching ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Logging in...</>
              ) : (
                'Get Started'
              )}
            </Button>
          </div>
          {isLaunching && (
            <ManualAccessKeyInput prefixText="Log in issues?" className="text-sm text-muted-foreground" />
          )}
        </div>
        <RequestError message={platformError ?? null} />
        <p className="text-sm text-muted-foreground">
          Need to bring your own keys?{' '}
          <button
            type="button"
            onClick={() => void handleManualSetup()}
            data-testid="wizard-manual-setup"
            disabled={updateSettings.isPending}
            className="underline underline-offset-2 hover:text-foreground transition-colors disabled:opacity-50"
          >
            {updateSettings.isPending ? <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> : null}
            Start BYOK setup
          </button>
        </p>
      </div>

    </div>
  )
}
