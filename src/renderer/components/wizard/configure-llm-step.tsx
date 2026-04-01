import { useState } from 'react'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { ProviderApiKeyInput } from '@renderer/components/settings/provider-api-key-input'
import { BedrockCredentialsInput } from '@renderer/components/settings/bedrock-credentials-input'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformConnect } from '@renderer/hooks/use-platform-auth'
import { ManualAccessKeyInput } from '@renderer/components/settings/manual-access-key-input'
import { ChevronRight, Loader2, LogIn } from 'lucide-react'
import type { LlmProviderId } from '@shared/lib/config/settings'

const PROVIDER_INSTRUCTIONS: Record<string, { steps: { text: string; link?: { href: string; label: string } }[] }> = {
  platform: {
    steps: [
      { text: 'Choose Platform as your provider' },
      { text: 'Connect your account from the Platform settings tab' },
      { text: 'SuperAgent will use your platform token and the hosted proxy automatically' },
    ],
  },
  anthropic: {
    steps: [
      { text: 'Sign up for an account at', link: { href: 'https://console.anthropic.com/login', label: 'console.anthropic.com' } },
      { text: 'Click your Profile in the top right corner and select API Keys' },
      { text: 'Click Create Key, name your key, and hit Create Key' },
    ],
  },
  openrouter: {
    steps: [
      { text: 'Sign up for an account at', link: { href: 'https://openrouter.ai', label: 'openrouter.ai' } },
      { text: 'Go to Keys in the dashboard' },
      { text: 'Click Create Key and copy your API key' },
    ],
  },
  bedrock: {
    steps: [
      { text: 'Open the', link: { href: 'https://console.aws.amazon.com/bedrock/', label: 'Amazon Bedrock console' } },
      { text: 'Enable access to Claude models in Model access' },
      { text: 'Create a Bedrock API key or use IAM credentials' },
    ],
  },
}

const SIMPLE_PROVIDER_KEY_CONFIG: Record<string, {
  label: string
  placeholder: string
  envVarName: string
  apiKeySettingsField: 'anthropicApiKey' | 'openrouterApiKey'
}> = {
  anthropic: {
    label: 'Anthropic API Key',
    placeholder: 'sk-ant-...',
    envVarName: 'ANTHROPIC_API_KEY',
    apiKeySettingsField: 'anthropicApiKey',
  },
  openrouter: {
    label: 'OpenRouter API Key',
    placeholder: 'sk-or-...',
    envVarName: 'OPENROUTER_API_KEY',
    apiKeySettingsField: 'openrouterApiKey',
  },
}

interface ConfigureLLMStepProps {
  mode?: 'manual' | 'platform'
  onPlatformConnected?: () => void
}

export function ConfigureLLMStep({ mode = 'manual', onPlatformConnected }: ConfigureLLMStepProps) {
  const [showInstructions, setShowInstructions] = useState(false)
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const {
    handleConnect,
    isLaunching,
    error: platformError,
    isConnected,
    platformAuth,
  } = usePlatformConnect({
    successMessage: null,
    onSuccess: () => {
      if (mode === 'platform') {
        onPlatformConnected?.()
      }
    },
  })

  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerStatus = settings?.llmProviderStatus ?? []
  const instructions = PROVIDER_INSTRUCTIONS[activeProvider]

  if (mode === 'platform') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-bold">Connect to Platform</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Sign in to Platform to use your subscription and hosted proxy.
          </p>
        </div>

        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {isConnected
              ? `Connected to ${platformAuth?.email ?? 'Platform'}. SuperAgent will use your Platform subscription automatically.`
              : 'Connect your account to continue with the Platform setup flow.'}
          </p>

          <Button
            type="button"
            variant="default"
            onClick={() => {
              void handleConnect()
            }}
            disabled={isLaunching}
          >
            {isLaunching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <LogIn className="mr-2 h-4 w-4" />
            )}
            Connect
          </Button>

          {platformError ? (
            <Alert variant="destructive">
              <AlertDescription>{platformError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <ManualAccessKeyInput />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Configure LLM Provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent needs either an API key or a Platform connection to communicate with AI models.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Provider</Label>
        <Select
          value={activeProvider}
          onValueChange={(value) => {
            updateSettings.mutate({ llmProvider: value as LlmProviderId })
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a provider" />
          </SelectTrigger>
          <SelectContent>
            {providerStatus.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {activeProvider === 'bedrock' ? (
        <BedrockCredentialsInput
          key="bedrock"
          showNotConfiguredAlert={false}
        />
      ) : activeProvider === 'platform' ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {isConnected
              ? `Connected to ${platformAuth?.email ?? 'Platform'}. SuperAgent will use your Platform subscription automatically.`
              : 'Platform not connected yet. Connect now to use your Platform subscription.'}
          </p>
          {!isConnected ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void handleConnect()
                }}
                disabled={isLaunching}
              >
                {isLaunching ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="mr-2 h-4 w-4" />
                )}
                Connect Platform
              </Button>
              {platformError ? (
                <Alert variant="destructive">
                  <AlertDescription>{platformError}</AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <ProviderApiKeyInput
          key={activeProvider}
          providerId={activeProvider}
          label={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].label}
          placeholder={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].placeholder}
          envVarName={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].envVarName}
          apiKeySettingsField={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].apiKeySettingsField}
          showNotConfiguredAlert={false}
          showHelpText={false}
          showRemoveButton={false}
        />
      )}

      {instructions && (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setShowInstructions(!showInstructions)}
            className="text-sm text-primary hover:underline flex items-center gap-1"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-90' : ''}`} />
            How to get started
          </button>

          {showInstructions && (
            <div className="mt-2 p-3 rounded-md border bg-muted/30 text-sm space-y-2">
              <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
                {instructions.steps.map((step, i) => (
                  <li key={i}>
                    {step.text}{step.link && (
                      <>
                        {' '}
                        <a
                          href={step.link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline underline-offset-4"
                        >
                          {step.link.label}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
