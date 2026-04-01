import { ChevronRight, Loader2 } from 'lucide-react'

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

  async function handlePlatformPath() {
    try {
      onChoosePlatform?.()
    } catch {
      // Keep the welcome page lightweight. Subsequent steps handle recovery.
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Welcome to Superagent</h2>
        <p className="text-muted-foreground">
          Superagent lets you create and manage AI agents that run in isolated containers.
          Each agent has its own environment, tools, and can connect to external services.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Connect to Platform</h3>
              <p className="text-sm text-muted-foreground">
                Use your Platform subscription and hosted proxy.
              </p>
            </div>

            <Button
              type="button"
              variant="default"
              onClick={() => {
                void handlePlatformPath()
              }}
              data-testid="wizard-platform-login"
              className="shrink-0"
            >
              Next
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Bring your own keys</h3>
              <p className="text-sm text-muted-foreground">
                Bring your own keys for providers like Anthropic, Deepgram, and Composio.
              </p>
            </div>

            <Button
              type="button"
              variant="default"
              onClick={() => {
                void handleManualSetup()
              }}
              data-testid="wizard-manual-setup"
              className="shrink-0"
              disabled={updateSettings.isPending}
            >
              {updateSettings.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <>
                  Next
                  <ChevronRight className="ml-2 h-4 w-4" />
                </>
              )}
              {updateSettings.isPending ? 'Next' : null}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
