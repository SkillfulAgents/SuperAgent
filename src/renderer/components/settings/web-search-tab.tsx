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

// One entry per provider. `apiKey` is present only for vendors that need a key (absent for native);
// the API-key block below renders straight from it, so a new vendor is a data entry, not new JSX.
type WebSearchProviderOption = {
  value: WebSearchProviderId
  label: string
  note: string
  docsUrl?: string
  apiKey?: {
    settingsField: string
    statusKey: string
    envVarName: string
    label: string
    placeholder: string
  }
}

const WEB_SEARCH_PROVIDERS: WebSearchProviderOption[] = [
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
    apiKey: {
      settingsField: 'exaApiKey',
      statusKey: 'exa',
      envVarName: 'EXA_API_KEY',
      label: 'Exa API Key',
      placeholder: 'Enter your Exa API key',
    },
  },
  {
    value: 'parallel',
    label: 'Parallel',
    note: 'Agentic web search with markdown excerpts and domain/date filtering. Works on any model. Requires a Parallel API key.',
    docsUrl: 'https://docs.parallel.ai',
    apiKey: {
      settingsField: 'parallelApiKey',
      statusKey: 'parallel',
      envVarName: 'PARALLEL_API_KEY',
      label: 'Parallel API Key',
      placeholder: 'Enter your Parallel API key',
    },
  },
  {
    value: 'youcom',
    label: 'You.com',
    note: 'Web search with snippets and recency filtering. Works on any model. Requires a You.com API key.',
    docsUrl: 'https://documentation.you.com',
    apiKey: {
      settingsField: 'youComApiKey',
      statusKey: 'youcom',
      envVarName: 'YOU_API_KEY',
      label: 'You.com API Key',
      placeholder: 'Enter your You.com API key',
    },
  },
  {
    value: 'firecrawl',
    label: 'Firecrawl',
    note: 'Web search backed by Firecrawl. Works on any model. Requires a Firecrawl API key.',
    docsUrl: 'https://docs.firecrawl.dev',
    apiKey: {
      settingsField: 'firecrawlApiKey',
      statusKey: 'firecrawl',
      envVarName: 'FIRECRAWL_API_KEY',
      label: 'Firecrawl API Key',
      placeholder: 'Enter your Firecrawl API key',
    },
  },
]

export function WebSearchTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const selected: WebSearchProviderId = settings?.webSearchProvider ?? 'native'
  const selectedInfo = WEB_SEARCH_PROVIDERS.find((p) => p.value === selected)

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

          {selectedInfo && (
            <p className="text-xs text-muted-foreground">
              {selectedInfo.note}
              {selectedInfo.docsUrl && (
                <>
                  {' '}
                  <a
                    href={selectedInfo.docsUrl}
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
          )}
        </div>
      </div>

      {selectedInfo?.apiKey && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">API Key</h3>
          <ProviderApiKeyInput
            providerId={selectedInfo.value}
            label={selectedInfo.apiKey.label}
            apiKeySettingsField={selectedInfo.apiKey.settingsField}
            apiKeyStatusKey={selectedInfo.apiKey.statusKey}
            validationEndpoint="/api/settings/validate-web-search-key"
            validationBody={(apiKey) => ({ provider: selectedInfo.value, apiKey })}
            envVarName={selectedInfo.apiKey.envVarName}
            placeholder={selectedInfo.apiKey.placeholder}
          />
        </div>
      )}
    </div>
  )
}
