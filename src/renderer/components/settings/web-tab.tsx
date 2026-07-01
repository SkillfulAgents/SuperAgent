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
import type { WebFetchProviderId, WebSearchProviderId } from '@shared/lib/config/settings'
import { ProviderApiKeyInput } from './provider-api-key-input'

// One "Web" tab with independent Search and Fetch provider selects. Both vendors are Exa today and
// share ONE Exa API key (settings.apiKeys.exaApiKey), so the key input renders once, whenever EITHER
// select uses Exa — no duplicated key field. A `usesExaKey` flag on an option marks vendors backed
// by the shared Exa key, so adding an Exa-backed vendor stays a data entry, not new JSX.
type ProviderOption<T extends string> = {
  value: T
  label: string
  note: string
  docsUrl?: string
  usesExaKey?: boolean
}

const SEARCH_PROVIDERS: ProviderOption<WebSearchProviderId>[] = [
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
    usesExaKey: true,
  },
]

const FETCH_PROVIDERS: ProviderOption<WebFetchProviderId>[] = [
  {
    value: 'native',
    label: 'Native',
    note: "Claude's built-in WebFetch. Works only on Claude models, no API key required.",
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Reads a page in full via Exa Contents. Works on any model. Requires an Exa API key.',
    docsUrl: 'https://docs.exa.ai',
    usesExaKey: true,
  },
]

function ProviderSelect<T extends string>({
  id,
  heading,
  description,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string
  heading: string
  description: string
  options: ProviderOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const selectedInfo = options.find((p) => p.value === value)
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{heading}</h3>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id}>Provider</Label>
        <Select value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Select a provider" />
          </SelectTrigger>
          <SelectContent>
            {options.map((p) => (
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
  )
}

export function WebTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  const selectedSearch: WebSearchProviderId = settings?.webSearchProvider ?? 'native'
  const selectedFetch: WebFetchProviderId = settings?.webFetchProvider ?? 'native'

  const searchUsesExa = SEARCH_PROVIDERS.find((p) => p.value === selectedSearch)?.usesExaKey ?? false
  const fetchUsesExa = FETCH_PROVIDERS.find((p) => p.value === selectedFetch)?.usesExaKey ?? false
  const needsExaKey = searchUsesExa || fetchUsesExa

  // Both selects validate the same Exa key; use whichever endpoint matches an active Exa consumer
  // (search validates via /search, fetch via /contents — the key is the same for both).
  const validationEndpoint = searchUsesExa
    ? '/api/settings/validate-web-search-key'
    : '/api/settings/validate-web-fetch-key'

  return (
    <div className="space-y-6">
      <ProviderSelect
        id="web-search-provider"
        heading="Web Search Provider"
        description="Choose what the agent uses for web search. A configured vendor is used on every model; native is the default when none is set."
        options={SEARCH_PROVIDERS}
        value={selectedSearch}
        onChange={(value) => updateSettings.mutate({ webSearchProvider: value })}
        disabled={isLoading}
      />

      <div className="pt-4 border-t">
        <ProviderSelect
          id="web-fetch-provider"
          heading="Web Fetch Provider"
          description="Choose what the agent uses to read a page in full. A configured vendor is used on every model; native is the default when none is set."
          options={FETCH_PROVIDERS}
          value={selectedFetch}
          onChange={(value) => updateSettings.mutate({ webFetchProvider: value })}
          disabled={isLoading}
        />
      </div>

      {needsExaKey && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">Exa API Key</h3>
          <p className="text-xs text-muted-foreground">
            Shared by Exa web search and web fetch.
          </p>
          <ProviderApiKeyInput
            providerId="exa"
            label="Exa API Key"
            apiKeySettingsField="exaApiKey"
            apiKeyStatusKey="exa"
            validationEndpoint={validationEndpoint}
            validationBody={(apiKey) => ({ provider: 'exa', apiKey })}
            envVarName="EXA_API_KEY"
            placeholder="Enter your Exa API key"
          />
        </div>
      )}
    </div>
  )
}
