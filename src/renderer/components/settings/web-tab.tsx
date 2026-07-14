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

const WEB_PROVIDERS: {
  value: WebProviderId
  label: string
  note: string
  docsUrl?: string
  platformOnly?: boolean
}[] = [
  {
    value: 'platform',
    label: 'Platform',
    note: 'Web search and full page reading, included with your Gamut plan. Works with every model, and there is nothing to set up.',
    platformOnly: true,
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Web search and full page reading through Exa. Works with every model. You bring your own Exa API key and are billed by Exa.',
    docsUrl: 'https://docs.exa.ai',
  },
  {
    value: 'native',
    label: 'Native',
    note: 'Uses whatever web tools the model already has built in. Nothing to set up, but not every model has them.',
  },
]

export function WebTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false

  const selected: WebProviderId = settings?.webProvider ?? 'native'
  const isDefault = settings?.webProviderIsDefault ?? true
  const selectedInfo = WEB_PROVIDERS.find((p) => p.value === selected)

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Web Provider</h3>
          <p className="text-xs text-muted-foreground mt-1">
            How your agents search the web and read pages. If you don&apos;t pick one, Platform is used when you&apos;re signed into Gamut; otherwise Native.
          </p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="web-provider">Provider</Label>
            {isDefault && <span className="text-xs text-muted-foreground">(default)</span>}
          </div>
          <Select
            value={selected}
            onValueChange={(v) => updateSettings.mutate({ webProvider: v as WebProviderId })}
            disabled={isLoading}
          >
            <SelectTrigger id="web-provider">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {WEB_PROVIDERS.map((p) => {
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

      {selected === 'exa' && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">Exa API Key</h3>
          <p className="text-xs text-muted-foreground">
            Used to search the web and read pages.
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
