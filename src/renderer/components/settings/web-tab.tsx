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

// One "Web" tab with a single user-facing Web Provider select. Search and fetch stay two separate
// providers/routes under the hood (so platform can route each to its best vendor); the desktop app
// keeps them in lockstep by writing both settings fields on change and reading search as canonical.
// A `usesExaKey` flag marks vendors backed by the shared Exa key (settings.apiKeys.exaApiKey), so the
// key input renders once and adding an Exa-backed vendor stays a data entry, not new JSX.
type ProviderOption<T extends string> = {
  value: T
  label: string
  note: string
  docsUrl?: string
  usesExaKey?: boolean
}

const WEB_PROVIDERS: ProviderOption<WebSearchProviderId>[] = [
  {
    value: 'native',
    label: 'Native',
    note: "Anthropic's built-in web search and Claude's WebFetch. Works only on Claude models, no API key required.",
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Neural web search plus full-page reads via Exa Contents. Works on any model. Requires an Exa API key.',
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

  // Read search as canonical; the control writes both fields together so they never diverge here.
  const selected: WebSearchProviderId = settings?.webSearchProvider ?? 'native'
  const needsExaKey = WEB_PROVIDERS.find((p) => p.value === selected)?.usesExaKey ?? false

  return (
    <div className="space-y-6">
      <ProviderSelect
        id="web-provider"
        heading="Web Provider"
        description="Choose what the agent uses for web search and reading pages in full. A configured vendor is used on every model; native is the default when none is set."
        options={WEB_PROVIDERS}
        value={selected}
        onChange={(value) => updateSettings.mutate({ webSearchProvider: value, webFetchProvider: value })}
        disabled={isLoading}
      />

      {needsExaKey && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">Exa API Key</h3>
          <p className="text-xs text-muted-foreground">
            Used by Exa web search and web fetch.
          </p>
          <ProviderApiKeyInput
            providerId="exa"
            label="Exa API Key"
            apiKeySettingsField="exaApiKey"
            apiKeyStatusKey="exa"
            validationEndpoint="/api/settings/validate-web-search-key"
            validationBody={(apiKey) => ({ provider: 'exa', apiKey })}
            envVarName="EXA_API_KEY"
            placeholder="Enter your Exa API key"
          />
        </div>
      )}
    </div>
  )
}
