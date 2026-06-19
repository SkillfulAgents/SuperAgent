import type { ReactNode } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { AlertTriangle, Lock } from 'lucide-react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { BedrockCredentialsInput } from './bedrock-credentials-input'
import { SettingsModelSelect } from './settings-model-select'
import type { LlmProviderId } from '@shared/lib/config/settings'
import type { EffortLevel } from '@shared/lib/container/types'

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

const PROVIDER_DESCRIPTIONS: Partial<Record<LlmProviderId, string>> = {
  anthropic: 'Direct API access to Claude models.',
  openrouter: 'Multi-model access through a single API key.',
  bedrock: 'AWS-managed Claude inference with IAM or API key credentials.',
  platform: 'Use credentials provided by your Gamut account.',
}

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

interface SettingRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
  /** When set, the name renders as a <label> bound to the control with this id. */
  htmlFor?: string
}

function SettingRow({ name, subtitle, right, htmlFor }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="block text-xs font-medium truncate cursor-pointer">{name}</label>
          ) : (
            <div className="text-xs font-medium truncate">{name}</div>
          )}
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

interface ModelEffortRowProps {
  name: string
  subtitle: string
  model: string | undefined
  /** Reasoning effort; only surfaced when `includeEffort` is true. */
  effort?: EffortLevel
  includeEffort?: boolean
  emit?: 'model' | 'family'
  disabled?: boolean
  onModelChange: (model: string) => void
  onEffortChange?: (effort: EffortLevel) => void
}

/** SettingRow wrapper around the shared settings model (+ effort) selector. */
function ModelEffortRow({
  name,
  subtitle,
  model,
  effort,
  includeEffort,
  emit,
  disabled,
  onModelChange,
  onEffortChange,
}: ModelEffortRowProps) {
  return (
    <SettingRow
      name={name}
      subtitle={subtitle}
      right={
        <SettingsModelSelect
          model={model}
          onModelChange={onModelChange}
          includeEffort={includeEffort}
          effort={effort}
          emit={emit}
          onEffortChange={onEffortChange}
          disabled={disabled}
        />
      }
    />
  )
}

interface ProviderCardProps {
  id: LlmProviderId
  name: string
  description?: string
  selected: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  children?: ReactNode
}

function ProviderCard({
  id,
  name,
  description,
  selected,
  disabled = false,
  disabledReason,
  onSelect,
  children,
}: ProviderCardProps) {
  return (
    <div
      className={`rounded-xl border bg-background transition-colors ${
        selected ? 'border-primary' : disabled ? 'opacity-60' : 'hover:border-muted-foreground/40'
      }`}
      data-testid={`llm-provider-card-${id}`}
    >
      <button
        type="button"
        role="radio"
        onClick={disabled ? undefined : onSelect}
        disabled={disabled}
        className="w-full flex items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
      >
        <div
          className={`mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
            selected ? 'border-primary' : 'border-muted-foreground/40'
          }`}
        >
          {selected && <div className="h-2 w-2 rounded-full bg-primary" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {disabled && disabledReason && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Lock className="h-3 w-3" />
                {disabledReason}
              </span>
            )}
          </div>
          {description && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
          )}
        </div>
      </button>

      {/* Expanded credentials area when selected */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          selected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {/* Only mount when selected: a collapsed grid-rows-[0fr] still leaves
              inputs in the DOM and keyboard tab order, so render conditionally. */}
          {selected && (
            <div className="px-4 pb-6 pt-5 border-t border-border/50">{children}</div>
          )}
        </div>
      </div>
    </div>
  )
}

export function LlmTab() {
  const { data: settings, isLoading } = useSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const updateSettings = useUpdateSettings()

  const isPlatformConnected = platformAuth?.connected ?? false
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerStatus = settings?.llmProviderStatus ?? []

  return (
    <div className="space-y-6">
      {/* Provider selection — radio cards, expanded card shows credentials + models */}
      <div className="space-y-3">
        <div role="radiogroup" aria-label="LLM provider" className="space-y-3">
        {providerStatus.map((provider) => {
          const isSelected = activeProvider === provider.id
          const platformLocked = provider.id === 'platform' && !isPlatformConnected
          const modelOptions = provider.availableModels ?? []
          const keyConfig = SIMPLE_PROVIDER_KEY_CONFIG[provider.id]

          return (
            <ProviderCard
              key={provider.id}
              id={provider.id}
              name={provider.name}
              description={PROVIDER_DESCRIPTIONS[provider.id]}
              selected={isSelected}
              disabled={platformLocked || isLoading}
              disabledReason={platformLocked ? 'Requires Account login' : undefined}
              onSelect={() => updateSettings.mutate({ llmProvider: provider.id })}
            >
              {provider.id === 'platform' ? (
                <p className="text-xs text-muted-foreground">
                  {isPlatformConnected
                    ? 'Your account is providing credentials. Manage it from the Account settings tab.'
                    : 'Connect from the Account settings tab to use this provider.'}
                </p>
              ) : provider.id === 'bedrock' ? (
                <BedrockCredentialsInput
                  key="bedrock"
                  disabled={isLoading}
                  showNotConfiguredAlert={false}
                />
              ) : keyConfig ? (
                <ProviderApiKeyInput
                  key={provider.id}
                  providerId={provider.id}
                  label={keyConfig.label}
                  placeholder={keyConfig.placeholder}
                  envVarName={keyConfig.envVarName}
                  apiKeySettingsField={keyConfig.apiKeySettingsField}
                  disabled={isLoading}
                  showNotConfiguredAlert={false}
                />
              ) : null}

              {/* Model selection lives inside the selected provider since available models are provider-specific */}
              <div className="mt-6 -mx-4 -mb-6 border-t border-border/50">
                {modelOptions.length === 0 ? (
                  <p className="px-4 py-3 text-[11px] text-muted-foreground">
                    Configure credentials to load available models.
                  </p>
                ) : (
                  <div className="divide-y divide-border/50">
                    <ModelEffortRow
                      name="Default model"
                      subtitle="Model and effort new sessions start with, before any per-message override"
                      model={settings?.models?.agentModel}
                      effort={settings?.models?.agentEffort ?? 'medium'}
                      includeEffort
                      emit="family"
                      disabled={isLoading}
                      onModelChange={(model) => updateSettings.mutate({ models: { agentModel: model } })}
                      onEffortChange={(effort) => updateSettings.mutate({ models: { agentEffort: effort } })}
                    />
                    <ModelEffortRow
                      name="Summarizer model"
                      subtitle="Used for session name generation and API key validation"
                      model={settings?.models?.summarizerModel}
                      includeEffort={false}
                      disabled={isLoading}
                      onModelChange={(model) => updateSettings.mutate({ models: { summarizerModel: model } })}
                    />
                  </div>
                )}
              </div>
            </ProviderCard>
          )
        })}
        </div>

        {settings?.hasRunningAgents && (
          <div className="flex gap-2 rounded-md bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-500/90 leading-relaxed">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>Running agents will use the previous provider until restarted.</p>
          </div>
        )}
      </div>

      {/* Advanced */}
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Advanced</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Tool search"
            htmlFor="enable-tool-search"
            subtitle="Load tool definitions on demand to save ~15-20K tokens per turn. Disable only when debugging. Requires Sonnet/Opus 4+; ignored on Haiku."
            right={
              <Switch
                id="enable-tool-search"
                checked={settings?.enableToolSearch !== false}
                onCheckedChange={(checked: boolean) => {
                  updateSettings.mutate({ enableToolSearch: checked })
                }}
                disabled={isLoading}
              />
            }
          />
        </div>
      </div>
    </div>
  )
}
