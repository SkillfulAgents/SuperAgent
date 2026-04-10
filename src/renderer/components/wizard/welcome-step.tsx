import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'

interface WelcomeStepProps {
  onChoosePlatform?: () => void
  onContinueToManualSetup?: () => void
}

export function WelcomeStep({ onChoosePlatform, onContinueToManualSetup }: WelcomeStepProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

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
        <h2 className="text-2xl font-bold">Welcome to Superagent</h2>
        <p className="text-muted-foreground">
          Superagent lets you create and manage AI agents that run in isolated containers.
          Each agent has its own environment, tools, and can connect to external services.
        </p>
      </div>

      <div className="flex flex-col gap-8">
        <Button
          type="button"
          variant="default"
          size="lg"
          onClick={() => onChoosePlatform?.()}
          data-testid="wizard-platform-login"
          className="w-full max-w-[380px]"
        >
          Get Started
        </Button>
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
