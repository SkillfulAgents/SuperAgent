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
import {
  PLATFORM_AUTH_CHOICE_STORAGE_KEY,
  useApplyPlatformDefaults,
  useInitiatePlatformLogin,
  usePlatformAuthCallbackListener,
  usePlatformAuthStatus,
} from '@renderer/hooks/use-platform-auth'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { ChevronRight, Loader2, LogIn } from 'lucide-react'
import type { LlmProviderId } from '@shared/lib/config/settings'

const PROVIDER_INSTRUCTIONS: Record<string, { steps: { text: string; link?: { href: string; label: string } }[] }> = {
  datawizz: {
    steps: [
      { text: 'Choose Datawizz Platform as your provider' },
      { text: 'Connect your Datawizz account from the Platform settings tab' },
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

export function ConfigureLLMStep() {
  const [showInstructions, setShowInstructions] = useState(false)
  const [platformError, setPlatformError] = useState<string | null>(null)
  const [isLaunchingPlatformLogin, setIsLaunchingPlatformLogin] = useState(false)
  const { data: settings } = useSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const applyPlatformDefaults = useApplyPlatformDefaults()
  const initiatePlatformLogin = useInitiatePlatformLogin()
  const updateSettings = useUpdateSettings()

  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerStatus = settings?.llmProviderStatus ?? []
  const instructions = PROVIDER_INSTRUCTIONS[activeProvider]

  usePlatformAuthCallbackListener((params) => {
    setIsLaunchingPlatformLogin(false)
    if (params.success) {
      window.localStorage.setItem(PLATFORM_AUTH_CHOICE_STORAGE_KEY, 'platform')
      setPlatformError(null)
      void applyPlatformDefaults().catch((err) => {
        setPlatformError(err instanceof Error ? err.message : 'Failed to apply platform defaults.')
      })
      return
    }
    setPlatformError(params.error || 'Platform login failed.')
  })

  async function handlePlatformConnect() {
    const popup = prepareOAuthPopup()
    setPlatformError(null)
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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Configure LLM Provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent needs either an API key or a Datawizz Platform connection to communicate with AI models.
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
      ) : activeProvider === 'datawizz' ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {platformAuth?.connected
              ? 'Platform connected. SuperAgent will use your Datawizz Platform subscription automatically.'
              : 'Platform not connected yet. Connect now to use your Datawizz Platform subscription.'}
          </p>
          {!platformAuth?.connected ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void handlePlatformConnect()
                }}
                disabled={isLaunchingPlatformLogin || initiatePlatformLogin.isPending}
              >
                {isLaunchingPlatformLogin || initiatePlatformLogin.isPending ? (
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
