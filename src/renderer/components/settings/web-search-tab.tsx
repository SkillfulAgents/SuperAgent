import { ExternalLink } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Label } from '@renderer/components/ui/label'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import type { WebSearchProviderId } from '@shared/lib/config/settings'
import { ProviderApiKeyInput } from './provider-api-key-input'

const WEB_SEARCH_PROVIDERS: {
  value: WebSearchProviderId
  label: string
  note: string
  docsUrl?: string
}[] = [
  {
    value: 'native',
    label: 'Native',
    note: "Anthropic's built-in web search. Works only on Claude models, no API key required.",
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Neural web search with snippets and date filtering. Works on any model. Requires an Exa API key.',
    docsUrl: 'https://docs.exa.ai',
  },
]

export function WebSearchTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const selected: WebSearchProviderId = settings?.webSearchProvider ?? 'native'

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Web Search Provider</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Choose what the agent uses for web search. A configured vendor is used on every model;
            native is the default when none is set.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="web-search-provider">Provider</Label>
          <Select
            value={selected}
            onValueChange={(value) => updateSettings.mutate({ webSearchProvider: value as WebSearchProviderId })}
            disabled={isLoading}
          >
            <SelectTrigger id="web-search-provider">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {WEB_SEARCH_PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(() => {
            const info = WEB_SEARCH_PROVIDERS.find((p) => p.value === selected)
            if (!info) return null
            return (
              <p className="text-xs text-muted-foreground">
                {info.note}
                {info.docsUrl && (
                  <>
                    {' '}
                    <a
                      href={info.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                    >
                      View docs
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </p>
            )
          })()}
        </div>
      </div>

      {selected === 'exa' && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">API Key</h3>
          <ProviderApiKeyInput
            providerId="exa"
            label="Exa API Key"
            apiKeySettingsField="exaApiKey"
            apiKeyStatusKey="exa"
            validationEndpoint="/api/settings/validate-exa-key"
            validationBody={(apiKey) => ({ apiKey })}
            envVarName="EXA_API_KEY"
            placeholder="Enter your Exa API key"
          />
        </div>
      )}
    </div>
  )
}
