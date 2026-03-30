import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { AlertTriangle } from 'lucide-react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { BedrockCredentialsInput } from './bedrock-credentials-input'
import type { LlmProviderId } from '@shared/lib/config/settings'

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

export function LlmTab() {
  const { data: settings, isLoading } = useSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const updateSettings = useUpdateSettings()

  const isPlatformConnected = platformAuth?.connected ?? false
  const activeProvider = settings?.llmProvider ?? 'anthropic'
  const providerStatus = settings?.llmProviderStatus ?? []
  const activeProviderInfo = providerStatus.find(p => p.id === activeProvider)
  const modelOptions = activeProviderInfo?.availableModels ?? []

  return (
    <div className="space-y-6">
      {/* Provider Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">LLM Provider</h3>
        <div className="space-y-2">
          <Label htmlFor="llm-provider">Provider</Label>
          <Select
            value={activeProvider}
            onValueChange={(value) => {
              if (value === 'platform' && !isPlatformConnected) return
              updateSettings.mutate({ llmProvider: value as LlmProviderId })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="llm-provider">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {providerStatus.map((provider) => (
                <SelectItem
                  key={provider.id}
                  value={provider.id}
                  disabled={provider.id === 'platform' && !isPlatformConnected}
                >
                  {provider.name}
                  {provider.id === 'platform' && !isPlatformConnected && (
                    <span className="text-muted-foreground ml-2">(requires platform login)</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {settings?.hasRunningAgents && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Running agents will use the previous provider until restarted.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Credentials Section */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium">
          {activeProvider === 'bedrock'
            ? 'Credentials'
            : activeProvider === 'platform'
              ? 'Platform Connection'
              : 'API Key'}
        </h3>
        {activeProvider === 'bedrock' ? (
          <BedrockCredentialsInput key="bedrock" disabled={isLoading} />
        ) : activeProvider === 'platform' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {platformAuth?.connected ? 'Platform connected.' : 'Platform not connected. Connect it from the `Platform` settings tab.'}
            </p>
          </div>
        ) : (
          <ProviderApiKeyInput
            key={activeProvider}
            providerId={activeProvider}
            label={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].label}
            placeholder={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].placeholder}
            envVarName={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].envVarName}
            apiKeySettingsField={SIMPLE_PROVIDER_KEY_CONFIG[activeProvider].apiKeySettingsField}
            disabled={isLoading}
          />
        )}
      </div>

      {/* Models Section */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium">Models</h3>
        <div className="space-y-2">
          <Label htmlFor="agent-model">Agent Model</Label>
          <Select
            value={settings?.models?.agentModel ?? modelOptions[0]?.value ?? ''}
            onValueChange={(value) => {
              updateSettings.mutate({ models: { agentModel: value } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="agent-model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Model used for agent sessions
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="summarizer-model">Summarizer Model</Label>
          <Select
            value={settings?.models?.summarizerModel ?? modelOptions[0]?.value ?? ''}
            onValueChange={(value) => {
              updateSettings.mutate({ models: { summarizerModel: value } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="summarizer-model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Model used for session name generation and API key validation
          </p>
        </div>
      </div>
    </div>
  )
}
