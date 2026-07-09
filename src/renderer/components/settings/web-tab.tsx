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
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { WebProviderId } from '@shared/lib/config/settings'
import { ProviderApiKeyInput } from './provider-api-key-input'

// One "Web" tab with a single Web Provider select backing one `webProvider` setting. One vendor
// backs both search and fetch; whether each tool is host-routed or native is derived host-side from
// the vendor's capabilities. The select always shows a concrete vendor: an explicit choice if the
// user made one, otherwise the server's resolved best-available vendor (`effectiveWebProvider`)
// marked "(default)". Leaving it on the default keeps the stored field unset, so the server keeps
// resolving the best vendor as the user's Gamut/key state changes; picking a vendor pins it.
// A `usesExaKey` flag marks vendors backed by the shared Exa key (settings.apiKeys.exaApiKey), so the
// key input renders once and adding an Exa-backed vendor stays a data entry, not new JSX.
// `platformOnly` marks the Gamut-provided vendor, which is login-gated (selectable only when signed
// into Gamut).
type ProviderOption<T extends string> = {
  value: T
  label: string
  note: string
  docsUrl?: string
  usesExaKey?: boolean
  platformOnly?: boolean
}

const WEB_PROVIDERS: ProviderOption<WebProviderId>[] = [
  {
    value: 'native',
    label: 'Native',
    note: "The model's own built-in web tools - works on any model with native web search/fetch (Claude, and GPT over the Platform). No API key required.",
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Exa for both web search and fetch - neural search plus full-page reads (Exa Contents). Works on any model. Requires an Exa API key.',
    docsUrl: 'https://docs.exa.ai',
    usesExaKey: true,
  },
  {
    value: 'platform',
    label: 'Platform',
    note: 'Gamut-provided web search and full-page reads. Works on any model, no key needed - requires an active Gamut plan.',
    platformOnly: true,
  },
]

function ProviderSelect<T extends string>({
  id,
  heading,
  description,
  options,
  value,
  isDefault,
  onChange,
  disabled,
  isPlatformConnected,
}: {
  id: string
  heading: string
  description: string
  options: ProviderOption<T>[]
  value: T
  // The shown vendor is the auto-resolved default, not an explicit choice: mark it "(default)".
  isDefault?: boolean
  onChange: (value: T) => void
  disabled?: boolean
  isPlatformConnected?: boolean
}) {
  const selectedInfo = options.find((p) => p.value === value)
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{heading}</h3>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={id}>Provider</Label>
          {isDefault && <span className="text-xs text-muted-foreground">(default)</span>}
        </div>
        <Select value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Select a provider" />
          </SelectTrigger>
          <SelectContent>
            {options.map((p) => {
              const gated = !!p.platformOnly && !isPlatformConnected
              return (
                <SelectItem key={p.value} value={p.value} disabled={gated}>
                  {p.label}
                  {gated && (
                    <span className="text-muted-foreground ml-2">(requires Gamut login)</span>
                  )}
                </SelectItem>
              )
            })}
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
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false

  // Always show a concrete vendor: the explicit choice if one is stored, else the server's resolved
  // best-available vendor (effective id). Never an abstract "automatic" row.
  const selected: WebProviderId = settings?.webProvider ?? settings?.effectiveWebProvider ?? 'native'
  // No explicit choice stored -> the shown vendor is the auto-resolved default (adaptive, not pinned).
  const isDefault = settings?.webProvider == null

  // A pinned vendor whose credential has gone (Exa key deleted, signed out of Gamut) falls back
  // host-side. The raw and effective ids disagreeing IS that condition, for every vendor - so this
  // one gate replaces a per-vendor warning.
  const effective = settings?.effectiveWebProvider
  const fellBack = !isDefault && effective != null && effective !== selected
  const label = (id: WebProviderId) => WEB_PROVIDERS.find((p) => p.value === id)?.label ?? id

  // The Exa key field shows only when Exa is the active vendor (explicit or resolved-default).
  const needsExaKey = WEB_PROVIDERS.find((p) => p.value === selected)?.usesExaKey ?? false

  return (
    <div className="space-y-6">
      <ProviderSelect
        id="web-provider"
        heading="Web Provider"
        description="Choose what the agent uses for web search and reading pages in full. A configured vendor is used on every model; when you haven't chosen one, the best available is selected automatically."
        options={WEB_PROVIDERS}
        value={selected}
        isDefault={isDefault}
        isPlatformConnected={isPlatformConnected}
        onChange={(value) => updateSettings.mutate({ webProvider: value })}
        disabled={isLoading}
      />

      {fellBack && (
        <p className="text-xs text-muted-foreground">
          {label(selected)} is selected but not available right now. Using {label(effective)} until it
          is set up again.
        </p>
      )}

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
            validationEndpoint="/api/settings/validate-web-key"
            validationBody={(apiKey) => ({ provider: 'exa', apiKey })}
            envVarName="EXA_API_KEY"
            placeholder="Enter your Exa API key"
          />
        </div>
      )}
    </div>
  )
}
