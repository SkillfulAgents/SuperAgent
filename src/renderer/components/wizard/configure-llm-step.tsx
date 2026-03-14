import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { ProviderApiKeyInput } from '@renderer/components/settings/provider-api-key-input'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { ChevronRight } from 'lucide-react'
import type { LlmProviderId } from '@shared/lib/config/settings'

const PROVIDER_INSTRUCTIONS: Record<LlmProviderId, { steps: { text: string; link?: { href: string; label: string } }[] }> = {
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
}

const PROVIDER_KEY_CONFIG: Record<LlmProviderId, {
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
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerStatus = settings?.llmProviderStatus ?? []
  const instructions = PROVIDER_INSTRUCTIONS[activeProvider]
  const keyConfig = PROVIDER_KEY_CONFIG[activeProvider]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Configure LLM Provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent needs an API key to communicate with AI models.
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

      <ProviderApiKeyInput
        key={activeProvider}
        providerId={activeProvider}
        label={keyConfig.label}
        placeholder={keyConfig.placeholder}
        envVarName={keyConfig.envVarName}
        apiKeySettingsField={keyConfig.apiKeySettingsField}
        showNotConfiguredAlert={false}
        showHelpText={false}
        showRemoveButton={false}
      />

      <div className="pt-2">
        <button
          type="button"
          onClick={() => setShowInstructions(!showInstructions)}
          className="text-sm text-primary hover:underline flex items-center gap-1"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-90' : ''}`} />
          How to get an API key
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
    </div>
  )
}
