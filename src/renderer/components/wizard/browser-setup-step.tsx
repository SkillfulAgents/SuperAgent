import { useState } from 'react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { ChromeProfileSelect } from '@renderer/components/settings/chrome-profile-select'
import { BrowserbaseSettings } from '@renderer/components/settings/browser-tab'
import {
  Check,
  Globe,
  Monitor,
  Cloud,
} from 'lucide-react'
import type { HostBrowserProviderId } from '@shared/lib/config/settings'

const CONTAINER_VALUE = '__container__'

const BROWSER_HOST_OPTIONS = [
  {
    id: CONTAINER_VALUE,
    label: 'Container (built-in)',
    description: 'Use the built-in browser inside the agent container. No extra setup needed.',
    icon: Monitor,
  },
  {
    id: 'chrome' as HostBrowserProviderId,
    label: 'Google Chrome',
    description: 'Use Chrome installed on your machine. Supports profiles for logged-in sessions.',
    icon: Globe,
  },
  {
    id: 'browserbase' as HostBrowserProviderId,
    label: 'Browserbase',
    description: 'Use a remote cloud browser. Requires a Browserbase account with API credentials.',
    icon: Cloud,
  },
]

export function BrowserSetupStep() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [hostProvider, setHostProvider] = useState<string | null>(null)
  const [chromeProfileId, setChromeProfileId] = useState<string | null>(null)
  const [browserbaseApiKey, setBrowserbaseApiKey] = useState('')
  const [browserbaseProjectId, setBrowserbaseProjectId] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)

  const effectiveProvider = hostProvider ?? settings?.app?.hostBrowserProvider ?? CONTAINER_VALUE
  const providers = settings?.hostBrowserStatus?.providers ?? []
  const chromeProvider = providers.find((p) => p.id === 'chrome')
  const chromeProfiles = chromeProvider?.profiles ?? []
  const effectiveChromeProfileId = chromeProfileId ?? settings?.app?.chromeProfileId ?? ''

  const browserbaseProvider = providers.find((p) => p.id === 'browserbase')
  const hasSavedBrowserbaseCredentials = !!browserbaseProvider?.available

  const handleSelectProvider = (id: string) => {
    const providerId = id === CONTAINER_VALUE ? null : id as HostBrowserProviderId
    setHostProvider(id)
    updateSettings.mutate({ app: { hostBrowserProvider: providerId as HostBrowserProviderId | undefined } })
  }

  const handleValidateBrowserbase = async () => {
    if (!browserbaseApiKey.trim() || !browserbaseProjectId.trim()) return
    setIsValidating(true)
    setValidationResult(null)
    try {
      const res = await apiFetch('/api/settings/validate-browserbase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: browserbaseApiKey.trim(),
          projectId: browserbaseProjectId.trim(),
        }),
      })
      const result = await res.json()
      setValidationResult(result)
      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: {
            browserbaseApiKey: browserbaseApiKey.trim(),
            browserbaseProjectId: browserbaseProjectId.trim(),
          },
        })
        setBrowserbaseApiKey('')
        setBrowserbaseProjectId('')
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to validate credentials' })
    } finally {
      setIsValidating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Set Up Browser</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose how your agents browse the web. The default container browser works out of the box.
          This step is optional.
        </p>
      </div>

      <div className="space-y-3">
        {BROWSER_HOST_OPTIONS.map((option) => {
          const provider = providers.find((p) => p.id === option.id)
          const isSelected = effectiveProvider === option.id
          const Icon = option.icon
          return (
            <button
              key={option.id}
              type="button"
              className={`w-full flex items-start gap-3 p-3 rounded-lg border bg-card text-left transition-colors ${
                isSelected ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/50'
              }`}
              onClick={() => handleSelectProvider(option.id)}
            >
              <Icon className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{option.label}</span>
                  {provider && provider.available && (
                    <span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      Available
                    </span>
                  )}
                  {provider && !provider.available && provider.reason && (
                    <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
                      {provider.reason}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{option.description}</p>
              </div>
              <div className={`mt-1 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                isSelected ? 'border-primary' : 'border-muted-foreground/40'
              }`}>
                {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
              </div>
            </button>
          )
        })}
      </div>

      {effectiveProvider === 'chrome' && chromeProfiles.length > 0 && (
        <ChromeProfileSelect
          profiles={chromeProfiles}
          value={effectiveChromeProfileId}
          onValueChange={(profileId) => {
            setChromeProfileId(profileId)
            updateSettings.mutate({ app: { chromeProfileId: profileId } })
          }}
          idPrefix="wizard-chrome-profile"
        />
      )}

      {effectiveProvider === 'browserbase' && (
        <BrowserbaseSettings
          apiKey={browserbaseApiKey}
          projectId={browserbaseProjectId}
          onApiKeyChange={(v) => { setBrowserbaseApiKey(v); setValidationResult(null) }}
          onProjectIdChange={(v) => { setBrowserbaseProjectId(v); setValidationResult(null) }}
          isValidating={isValidating}
          validationResult={validationResult}
          hasSavedCredentials={hasSavedBrowserbaseCredentials}
          disabled={false}
          onValidateAndSave={handleValidateBrowserbase}
          onRemove={async () => {
            setIsValidating(true)
            try {
              await updateSettings.mutateAsync({
                apiKeys: {
                  browserbaseApiKey: '',
                  browserbaseProjectId: '',
                },
              })
              setBrowserbaseApiKey('')
              setBrowserbaseProjectId('')
              setValidationResult(null)
            } finally {
              setIsValidating(false)
            }
          }}
        />
      )}
    </div>
  )
}
