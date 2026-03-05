import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { HostBrowserProviderId } from '@shared/lib/config/settings'
import { ChromeProfileSelect } from '@renderer/components/settings/chrome-profile-select'

const MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
  { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
  { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
]

// Value used for "Container (built-in)" — no host browser provider
const CONTAINER_VALUE = '__container__'

export function BrowserTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Optimistic local state
  const [hostProvider, setHostProvider] = useState<string | null>(null)
  const [chromeProfileId, setChromeProfileId] = useState<string | null>(null)
  const [browserbaseApiKey, setBrowserbaseApiKey] = useState('')
  const [browserbaseProjectId, setBrowserbaseProjectId] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)

  const effectiveProvider = hostProvider ?? settings?.app?.hostBrowserProvider ?? CONTAINER_VALUE
  const effectiveChromeProfileId = chromeProfileId ?? settings?.app?.chromeProfileId ?? ''

  const providers = settings?.hostBrowserStatus?.providers ?? []
  const chromeProvider = providers.find((p) => p.id === 'chrome')
  const chromeProfiles = chromeProvider?.profiles ?? []

  return (
    <div className="space-y-6">
      {/* Browser Agent Model */}
      <div className="space-y-2">
        <Label htmlFor="browser-model">Browser Agent Model</Label>
        <Select
          value={settings?.models?.browserModel ?? 'claude-sonnet-4-6'}
          onValueChange={(value) => {
            updateSettings.mutate({ models: { browserModel: value } })
          }}
          disabled={isLoading}
        >
          <SelectTrigger id="browser-model">
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Model used for the web browser subagent
        </p>
      </div>

      {/* Browser Host selector */}
      <div className="space-y-2">
        <Label htmlFor="browser-host">Browser Host</Label>
        <Select
          value={effectiveProvider}
          onValueChange={(value) => {
            const providerId = value === CONTAINER_VALUE ? undefined : value as HostBrowserProviderId
            setHostProvider(value)
            updateSettings.mutate({
              app: { hostBrowserProvider: providerId },
            })
          }}
          disabled={isLoading}
        >
          <SelectTrigger id="browser-host">
            <SelectValue placeholder="Select browser host" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CONTAINER_VALUE}>
              Container (built-in)
            </SelectItem>
            {providers.map((provider) => (
              <SelectItem
                key={provider.id}
                value={provider.id}
                disabled={!provider.available && provider.id === 'chrome'}
              >
                {provider.name}
                {!provider.available && provider.id === 'chrome' && provider.reason
                  ? ` (${provider.reason})`
                  : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Choose where the browser runs. &quot;Container&quot; uses a built-in headless browser.
          External hosts reduce bot detection and support persistent sessions.
        </p>
      </div>

      {/* Chrome-specific: Profile selector */}
      {effectiveProvider === 'chrome' && chromeProfiles.length > 0 && (
        <ChromeProfileSelect
          profiles={chromeProfiles}
          value={effectiveChromeProfileId}
          onValueChange={(profileId) => {
            setChromeProfileId(profileId)
            updateSettings.mutate({ app: { chromeProfileId: profileId } })
          }}
          idPrefix="chrome-profile"
          disabled={isLoading}
        />
      )}

      {/* Browserbase-specific settings */}
      {effectiveProvider === 'browserbase' && (
        <BrowserbaseSettings
          apiKey={browserbaseApiKey}
          projectId={browserbaseProjectId}
          onApiKeyChange={(v) => { setBrowserbaseApiKey(v); setValidationResult(null) }}
          onProjectIdChange={(v) => { setBrowserbaseProjectId(v); setValidationResult(null) }}
          isValidating={isValidating}
          validationResult={validationResult}
          hasSavedCredentials={
            !!providers.find((p) => p.id === 'browserbase')?.available
          }
          disabled={isLoading}
          onValidateAndSave={async () => {
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
                // Clear inputs so the button hides — saved state is shown via placeholder
                setBrowserbaseApiKey('')
                setBrowserbaseProjectId('')
              }
            } catch {
              setValidationResult({ valid: false, error: 'Failed to validate credentials' })
            } finally {
              setIsValidating(false)
            }
          }}
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

export interface BrowserbaseSettingsProps {
  apiKey: string
  projectId: string
  onApiKeyChange: (value: string) => void
  onProjectIdChange: (value: string) => void
  isValidating: boolean
  validationResult: { valid: boolean; error?: string } | null
  hasSavedCredentials: boolean
  disabled: boolean
  onValidateAndSave: () => void
  onRemove: () => void
}

export function BrowserbaseSettings({
  apiKey,
  projectId,
  onApiKeyChange,
  onProjectIdChange,
  isValidating,
  validationResult,
  hasSavedCredentials,
  disabled,
  onValidateAndSave,
  onRemove,
}: BrowserbaseSettingsProps) {
  const hasInput = apiKey.trim().length > 0 && projectId.trim().length > 0

  return (
    <div className="space-y-4">
      {hasSavedCredentials && (
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
            Credentials saved
          </span>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="browserbase-api-key">Browserbase API Key</Label>
        <Input
          id="browserbase-api-key"
          type="password"
          placeholder={hasSavedCredentials ? '••••••••••••••••' : 'Enter your Browserbase API key'}
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          disabled={disabled || isValidating}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="browserbase-project-id">Browserbase Project ID</Label>
        <Input
          id="browserbase-project-id"
          type="text"
          placeholder={hasSavedCredentials ? '••••••••••••••••' : 'Enter your Browserbase project ID'}
          value={projectId}
          onChange={(e) => onProjectIdChange(e.target.value)}
          disabled={disabled || isValidating}
        />
      </div>

      {validationResult && (
        <Alert variant={validationResult.valid ? 'default' : 'destructive'}>
          {validationResult.valid ? (
            <Check className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          <AlertDescription>
            {validationResult.valid
              ? 'Credentials are valid and have been saved.'
              : validationResult.error || 'Invalid credentials'}
          </AlertDescription>
        </Alert>
      )}

      <p className="text-xs text-muted-foreground">
        {hasSavedCredentials
          ? 'Your credentials are saved locally. Enter new values to replace them.'
          : 'Get your API key and project ID from the Browserbase dashboard.'}
      </p>

      <div className="flex gap-2">
        {hasInput && (
          <Button size="sm" onClick={onValidateAndSave} disabled={isValidating}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Save & Validate'
            )}
          </Button>
        )}
        {hasSavedCredentials && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRemove}
            disabled={isValidating}
          >
            Remove Saved Credentials
          </Button>
        )}
      </div>
    </div>
  )
}
