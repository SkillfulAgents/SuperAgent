import { useEffect, useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { DECISION_MODELS, type DecisionProviderId } from '@shared/lib/decision/types'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { ProviderCard } from './web-tab'

const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

const DECISION_PROVIDER_OPTIONS: {
  value: DecisionProviderId
  label: string
  note: string
  /** Absent for Gamut, which uses the platform login instead of a key. */
  key?: { settingsField: string; envVarName: string; label: string }
}[] = [
  {
    value: 'platform',
    label: 'Gamut',
    note: 'GPT-6 Luna, included with your Gamut plan. Nothing to set up.',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    note: 'GPT-6 Luna. Long inputs. Can decline a question instead of guessing.',
    key: { settingsField: 'openaiApiKey', envVarName: 'OPENAI_API_KEY', label: 'OpenAI API Key' },
  },
  {
    value: 'typesafe',
    label: 'TypeSafe',
    note: 'Jev. Lowest price per token.',
    key: { settingsField: 'typesafeApiKey', envVarName: 'TYPESAFE_API_KEY', label: 'TypeSafe API Key' },
  },
  {
    value: 'cloudflare',
    label: 'Cloudflare',
    note: 'Clef on Workers AI. Reads only about the first 2K tokens of text.',
    key: { settingsField: 'cloudflareApiToken', envVarName: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare API Token' },
  },
]

function CloudflareAccountIdInput() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const saved = settings?.cloudflareAccountId ?? ''
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])

  const save = () => {
    const trimmed = value.trim()
    if (trimmed !== saved) updateSettings.mutate({ apiKeys: { cloudflareAccountId: trimmed } })
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="cloudflare-account-id">Cloudflare Account ID</Label>
      <Input
        id="cloudflare-account-id"
        value={value}
        placeholder="Enter your Cloudflare account ID"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save() }}
      />
    </div>
  )
}

export function DecisionTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false
  const selected = settings?.decision?.provider

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Decision Model</h3>
        <p className="text-[11px] text-muted-foreground px-1">
          A fast model that answers yes/no, pick-one and score questions with probabilities.
        </p>
        <div role="radiogroup" aria-label="Decision provider" className="space-y-3 pt-1">
          {DECISION_PROVIDER_OPTIONS.map((provider) => {
            const models = DECISION_MODELS[provider.value]
            const model = settings?.decision?.model ?? models[0]
            const gated = provider.value === 'platform' && !isPlatformConnected
            const key = provider.key
            const settingsBody = models.length > 1 || key
            return (
              <ProviderCard
                key={provider.value}
                id={provider.value}
                testIdPrefix="decision-provider-card"
                name={provider.label}
                description={provider.note}
                selected={selected === provider.value}
                disabled={gated || isLoading}
                disabledReason={gated ? 'Requires Gamut account' : undefined}
                onSelect={() => updateSettings.mutate({ decision: { provider: provider.value, model: models[0] } })}
              >
                {settingsBody && <div className="space-y-4">
                  {models.length > 1 && (
                    <div className="space-y-2">
                      <Label htmlFor="decision-model">Model</Label>
                      <Select
                        value={model}
                        onValueChange={(v) => updateSettings.mutate({ decision: { model: v } })}
                      >
                        <SelectTrigger id="decision-model">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {models.map((m) => (
                            <SelectItem key={m} value={m}>{m}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {provider.value === 'cloudflare' && <CloudflareAccountIdInput />}
                  {key && (
                    <ProviderApiKeyInput
                      providerId={provider.value}
                      label={key.label}
                      apiKeySettingsField={key.settingsField}
                      apiKeyStatusKey={provider.value}
                      validationEndpoint="/api/settings/validate-decision-key"
                      validationBody={(apiKey) => ({ provider: provider.value, apiKey })}
                      envVarName={key.envVarName}
                      helpText={provider.value === 'openai' ? 'Shared with OpenAI voice.' : undefined}
                    />
                  )}
                </div>}
              </ProviderCard>
            )
          })}
        </div>
      </div>
    </div>
  )
}
