import { useState, useEffect } from 'react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { ChromeProfileSelect } from '@renderer/components/settings/chrome-profile-select'
import { BrowserbaseSettings } from '@renderer/components/settings/browser-tab'
import type { HostBrowserProviderId } from '@shared/lib/config/settings'

const CONTAINER_VALUE = '__container__'

const BROWSER_HOST_OPTIONS: Array<{
  id: string
  label: string
  recommended?: boolean
  isDefault?: boolean
  isAdvanced?: boolean
  description: string
  subdescription?: string
}> = [
  {
    id: 'chrome' as HostBrowserProviderId,
    label: 'Google Chrome',
    recommended: true,
    description: 'Your agents can use sites you\'re already logged into Chrome.',
    subdescription: 'Just pick a Chrome profile.',
  },
  {
    id: CONTAINER_VALUE,
    label: 'Built-in Browser',
    recommended: false,
    isDefault: true,
    description: 'Your agents will need you to log in before they can use a site.',
    subdescription: 'No stored passwords or cookies.',
  },
  {
    id: 'browserbase' as HostBrowserProviderId,
    label: 'Browserbase',
    recommended: false,
    isAdvanced: true,
    description: 'Remote cloud browser. Requires a Browserbase account.',
  },
]

interface BrowserSetupStepProps {
  onCanProceedChange?: (canProceed: boolean) => void
}

export function BrowserSetupStep({ onCanProceedChange }: BrowserSetupStepProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [hostProvider, setHostProvider] = useState<string | null>(null)
  const [showAdvancedBrowsers, setShowAdvancedBrowsers] = useState(false)
  const [chromeProfileId, setChromeProfileId] = useState<string | null>(null)
  const [browserbaseApiKey, setBrowserbaseApiKey] = useState('')
  const [browserbaseProjectId, setBrowserbaseProjectId] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)

  const providers = settings?.hostBrowserStatus?.providers ?? []
  const chromeProvider = providers.find((p) => p.id === 'chrome')
  const isChromeAvailable = !!chromeProvider?.available
  const smartDefault = isChromeAvailable ? 'chrome' : CONTAINER_VALUE
  const effectiveProvider = hostProvider ?? settings?.app?.hostBrowserProvider ?? smartDefault
  const chromeProfiles = chromeProvider?.profiles ?? []
  const effectiveChromeProfileId = chromeProfileId ?? settings?.app?.chromeProfileId ?? ''

  const browserbaseProvider = providers.find((p) => p.id === 'browserbase')
  const hasSavedBrowserbaseCredentials = !!browserbaseProvider?.available

  // If Browserbase is selected, can only proceed with valid credentials
  useEffect(() => {
    if (effectiveProvider === 'browserbase') {
      onCanProceedChange?.(hasSavedBrowserbaseCredentials)
    } else {
      onCanProceedChange?.(true)
    }
  }, [effectiveProvider, hasSavedBrowserbaseCredentials, onCanProceedChange])

  const handleSelectProvider = (id: string) => {
    const providerId = id === CONTAINER_VALUE ? undefined : id as HostBrowserProviderId
    setHostProvider(id)
    updateSettings.mutate({ app: { hostBrowserProvider: providerId } })
  }

  const handleValidateBrowserbase = async () => {
    if (!browserbaseApiKey.trim() && !browserbaseProjectId.trim()) {
      setValidationResult({ valid: false, error: 'Enter your API key and project ID.' })
      return
    }
    if (!browserbaseApiKey.trim()) {
      setValidationResult({ valid: false, error: 'Enter your API key.' })
      return
    }
    if (!browserbaseProjectId.trim()) {
      setValidationResult({ valid: false, error: 'Enter your project ID.' })
      return
    }
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
      if (!res.ok) {
        setValidationResult({ valid: false, error: 'Failed to validate credentials' })
        return
      }
      const result = await res.json() as { valid: boolean; error?: string }
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
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Give your agents browser access</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your agents can use the internet on your behalf.<br />Choose the browser you want them to use by default.
        </p>
      </div>

      <div className="space-y-3">
        {BROWSER_HOST_OPTIONS.map((option) => {
          if (option.isAdvanced && !showAdvancedBrowsers) return null
          const provider = providers.find((p) => p.id === option.id)
          const isSelected = effectiveProvider === option.id
          const isDisabled = option.id === 'chrome' && provider && !provider.available
          return (
            <div
              key={option.id}
              className={`rounded-lg border text-left transition-colors ${
                isDisabled ? 'opacity-40' : isSelected ? 'border-primary bg-muted/50' : 'hover:border-muted-foreground/50'
              }`}
            >
              <button
                type="button"
                disabled={!!isDisabled}
                className="w-full flex items-start gap-3 p-3 text-left disabled:cursor-not-allowed"
                onClick={() => handleSelectProvider(option.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{option.label}</span>
                    {option.recommended && (
                      <span className="text-xs text-muted-foreground">recommended</span>
                    )}
                  {option.isDefault && (
                      <span className="text-xs text-muted-foreground">default</span>
                    )}
                  {option.isAdvanced && (
                      <span className="text-xs text-muted-foreground">advanced</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {option.description}
                    {option.subdescription && (<><br />{option.subdescription}</>)}
                  </p>
                </div>
                <div className={`mt-1 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  isSelected ? 'border-primary' : 'border-muted-foreground/40'
                }`}>
                  {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                </div>
              </button>

              {option.id === 'chrome' && chromeProfiles.length > 0 && (
                <div className={`grid transition-all duration-200 ease-in-out ${isSelected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                  <div className="overflow-hidden">
                    <div className="px-3 pb-3 pt-2">
                      <ChromeProfileSelect
                        profiles={chromeProfiles}
                        value={effectiveChromeProfileId}
                        onValueChange={(profileId) => {
                          setChromeProfileId(profileId)
                          updateSettings.mutate({ app: { chromeProfileId: profileId } })
                        }}
                        idPrefix="wizard-chrome-profile"
                      />
                    </div>
                  </div>
                </div>
              )}

              {option.id === 'browserbase' && (
                <div className={`grid transition-all duration-200 ease-in-out ${isSelected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                  <div className="overflow-hidden">
                <div className="px-3 pb-3 pt-0">
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
                </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!showAdvancedBrowsers ? (
        <div className="flex justify-start">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowAdvancedBrowsers(true)}
          >
            Show advanced options
          </button>
        </div>
      ) : (
        <div className="flex justify-start">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowAdvancedBrowsers(false)}
          >
            Show less
          </button>
        </div>
      )}
    </div>
  )
}
