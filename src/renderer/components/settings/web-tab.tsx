import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { WebProviderId } from '@shared/lib/config/settings'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { ProviderCard } from './provider-card'

const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

const WEB_PROVIDERS: {
  value: WebProviderId
  label: string
  note: string
  docsUrl?: string
  platformOnly?: boolean
}[] = [
  {
    value: 'platform',
    label: 'Gamut',
    note: 'Web search and full page reading, included with your Gamut plan. Nothing to set up.',
    platformOnly: true,
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Web search and full page reading. Works with every model. Bring your own Exa API key.',
    docsUrl: 'https://docs.exa.ai',
  },
  {
    value: 'parallel',
    label: 'Parallel',
    note: 'Free web search without an API key. Works with every model. Page reading uses the model’s built-in tools when available.',
    docsUrl: 'https://docs.parallel.ai/integrations/mcp/search-mcp',
  },
  {
    value: 'native',
    label: 'Native',
    note: "Uses the model's built-in web tools. Nothing to set up, but not all models have them.",
  },
]

export function WebTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false

  const selected: WebProviderId = settings?.webProvider ?? 'native'
  const isDefault = settings?.webProviderIsDefault ?? true

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Web Provider</h3>
        <p className="text-[11px] text-muted-foreground px-1">
          How your agents search the web and read pages. If you don&apos;t pick one, Gamut is
          used when you&apos;re signed in; otherwise Native.
        </p>
        <div role="radiogroup" aria-label="Web provider" className="space-y-3 pt-1">
          {WEB_PROVIDERS.map((provider) => {
            const gated = !!provider.platformOnly && !isPlatformConnected
            const isSelected = selected === provider.value
            return (
              <ProviderCard
                key={provider.value}
                id={provider.value}
                testIdPrefix="web-provider-card"
                name={provider.label}
                nameSuffix={
                  isSelected && isDefault ? (
                    <span className="text-xs text-muted-foreground">(default)</span>
                  ) : undefined
                }
                description={
                  <>
                    {provider.note}
                    {provider.docsUrl && (
                      <>
                        {' '}
                        <a
                          href={provider.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View {provider.label} docs
                        </a>
                      </>
                    )}
                  </>
                }
                selected={isSelected}
                disabled={gated || isLoading}
                disabledReason={gated ? 'Requires Gamut account' : undefined}
                onSelect={() => updateSettings.mutate({ webProvider: provider.value })}
              >
                {provider.value === 'exa' ? (
                  <ProviderApiKeyInput
                    providerId="exa"
                    label="Exa API Key"
                    apiKeySettingsField="exaApiKey"
                    apiKeyStatusKey="exa"
                    validationEndpoint="/api/settings/validate-web-key"
                    validationBody={(apiKey) => ({ provider: 'exa', apiKey })}
                    envVarName="EXA_API_KEY"
                    placeholder="Enter your Exa API key"
                  />
                ) : null}
              </ProviderCard>
            )
          })}
        </div>
      </div>
    </div>
  )
}
