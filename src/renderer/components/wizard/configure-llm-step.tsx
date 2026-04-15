import { useState, useEffect } from 'react'
import { ProviderApiKeyInput } from '@renderer/components/settings/provider-api-key-input'
import { BedrockCredentialsInput } from '@renderer/components/settings/bedrock-credentials-input'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { ChevronRight } from 'lucide-react'
import type { LlmProviderId } from '@shared/lib/config/settings'

const PROVIDER_INSTRUCTIONS: Record<string, { steps: { text: string; link?: { href: string; label: string } }[] }> = {
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

const LLM_PROVIDER_OPTIONS: Array<{
  id: LlmProviderId
  label: string
  description: string
}> = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    description: 'Direct API access to Claude models.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Multi-model access through a single API key.',
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    description: 'AWS managed Claude inference with IAM or API key credentials.',
  },
]

interface ConfigureLLMStepProps {
  onCanProceedChange?: (canProceed: boolean) => void
}

export function ConfigureLLMStep({ onCanProceedChange }: ConfigureLLMStepProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const [showInstructions, setShowInstructions] = useState<string | null>(null)

  // Report to parent whether the selected provider has configured keys
  const apiKeyStatus = (settings?.apiKeyStatus as Record<string, { isConfigured: boolean }> | undefined)
  const activeProviderConfigured = apiKeyStatus?.[activeProvider]?.isConfigured ?? false
  useEffect(() => {
    onCanProceedChange?.(activeProviderConfigured)
  }, [activeProviderConfigured, onCanProceedChange])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Connect an LLM provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Keys will be saved locally. Enter a new key to override previously set environment variables or saved keys. Manage saved keys in settings.
        </p>
      </div>

      <div className="space-y-3">
        {LLM_PROVIDER_OPTIONS.map((option) => {
          const isSelected = activeProvider === option.id
          const instructions = PROVIDER_INSTRUCTIONS[option.id]

          return (
            <div
              key={option.id}
              className={`rounded-lg border text-left transition-colors ${
                isSelected ? 'border-primary bg-muted/50' : 'hover:border-muted-foreground/50'
              }`}
            >
              <button
                type="button"
                className="w-full flex items-start gap-3 p-3 text-left"
                onClick={() => updateSettings.mutate({ llmProvider: option.id })}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{option.label}</span>
                  </div>
                </div>
                <div className={`mt-1 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  isSelected ? 'border-primary' : 'border-muted-foreground/40'
                }`}>
                  {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                </div>
              </button>

              {/* Expanded settings area when selected */}
              <div className={`grid transition-all duration-200 ease-in-out ${isSelected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="px-3 pb-3 pt-2">
                    {option.id === 'bedrock' ? (
                      <BedrockCredentialsInput
                        key="bedrock"
                        showNotConfiguredAlert={false}
                      />
                    ) : (
                      <ProviderApiKeyInput
                        key={option.id}
                        providerId={option.id}
                        label={SIMPLE_PROVIDER_KEY_CONFIG[option.id].label}
                        placeholder={SIMPLE_PROVIDER_KEY_CONFIG[option.id].placeholder}
                        envVarName={SIMPLE_PROVIDER_KEY_CONFIG[option.id].envVarName}
                        apiKeySettingsField={SIMPLE_PROVIDER_KEY_CONFIG[option.id].apiKeySettingsField}
                        showNotConfiguredAlert={false}
                        showHelpText={false}
                        showRemoveButton={false}
                      />
                    )}

                    {instructions && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => setShowInstructions(showInstructions === option.id ? null : option.id)}
                          className="text-sm text-primary hover:underline flex items-center gap-1"
                        >
                          <ChevronRight className={`h-3 w-3 transition-transform ${showInstructions === option.id ? 'rotate-90' : ''}`} />
                          How to get your API key
                        </button>

                        {showInstructions === option.id && (
                          <div className="mt-2 p-2.5 rounded-md border bg-muted/30">
                            <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
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
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
