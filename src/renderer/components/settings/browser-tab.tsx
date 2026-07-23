import { useState, type ReactNode } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@shared/lib/utils/cn'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { apiFetch } from '@renderer/lib/api'
import { Check, Loader2, Lock } from 'lucide-react'
import { RequestError } from '@renderer/components/messages/request-error'
import type { HostBrowserProviderId, BrowserbaseStealthOs } from '@shared/lib/config/settings'
import { ChromeProfileSelect } from '@renderer/components/settings/chrome-profile-select'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'

// Value used for "Container (built-in)" — no host browser provider
const CONTAINER_VALUE = '__container__'

// Preset tiers for the max-tabs picker. No 1: popup/OAuth flows need a second tab.
const MAX_TABS_OPTIONS = [5, 10, 20]

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

const HOST_DESCRIPTIONS: Record<string, ReactNode> = {
  [CONTAINER_VALUE]: 'Built-in headless browser. No stored passwords or cookies — agents need you to log in to sites.',
  chrome: "Your agents can use sites you're already logged into Chrome.",
  browserbase: (
    <>
      Remote cloud browser that reduces bot detection and supports persistent sessions.
      <br />
      Requires a Browserbase account.
    </>
  ),
  platform: 'Managed cloud browser using your Platform account.',
}

interface FieldRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
  htmlFor?: string
  /** Stack the control under the label below `md` — for wide controls (selects,
      text inputs) that would otherwise crush the label on mobile. */
  stack?: boolean
}

/** The row anatomy shared by card rows and expanded-card fields: name +
    supporting line on the left, control on the right. */
function FieldRow({ name, subtitle, right, htmlFor, stack }: FieldRowProps) {
  const Name = htmlFor ? 'label' : 'div'
  return (
    <div className={cn('flex gap-3', stack ? 'flex-col items-stretch md:flex-row md:items-center' : 'items-center')}>
      <div className="min-w-0 flex-1">
        <Name htmlFor={htmlFor} className={cn('text-xs font-medium truncate block', htmlFor ? 'cursor-pointer' : 'cursor-default')}>{name}</Name>
        {subtitle && <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>}
      </div>
      <div className={cn('flex items-center gap-2 shrink-0', stack && 'w-full md:w-auto')}>{right}</div>
    </div>
  )
}

interface SettingRowProps {
  name: string
  subtitle: ReactNode
  right: ReactNode
  htmlFor?: string
}

function SettingRow({ name, subtitle, right, htmlFor }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <FieldRow name={name} subtitle={subtitle} right={right} htmlFor={htmlFor} />
    </div>
  )
}

interface HostCardProps {
  id: string
  name: string
  description?: ReactNode
  selected: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  children?: ReactNode
}

/** Radio card that expands its provider-specific settings when selected —
    mirrors ProviderCard from the LLM provider tab. */
function HostCard({
  id,
  name,
  description,
  selected,
  disabled = false,
  disabledReason,
  onSelect,
  children,
}: HostCardProps) {
  return (
    <div
      className={`rounded-xl border bg-background transition-colors ${
        selected ? 'border-primary' : disabled ? 'opacity-60' : 'hover:border-muted-foreground/40'
      }`}
      data-testid={`browser-host-card-${id === CONTAINER_VALUE ? 'container' : id}`}
    >
      <button
        type="button"
        role="radio"
        onClick={disabled ? undefined : onSelect}
        disabled={disabled}
        className="w-full flex items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
      >
        <div
          className={`mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
            selected ? 'border-primary' : 'border-muted-foreground/40'
          }`}
        >
          {selected && <div className="h-2 w-2 rounded-full bg-primary" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {disabled && disabledReason && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Lock className="h-3 w-3" />
                {disabledReason}
              </span>
            )}
          </div>
          {description && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
          )}
        </div>
      </button>

      {/* Expanded settings area when selected */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          selected && children ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {/* Only mount when selected: a collapsed grid-rows-[0fr] still leaves
              inputs in the DOM and keyboard tab order, so render conditionally. */}
          {selected && children && (
            <div className="px-4 pb-6 pt-5 border-t border-border/50">{children}</div>
          )}
        </div>
      </div>
    </div>
  )
}

export function BrowserTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { track } = useAnalyticsTracking()

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

  // Values stored by the old free-form input (1–20) may fall outside the presets;
  // surface them so the trigger doesn't render empty.
  const maxTabs = settings?.app?.maxBrowserTabs ?? 10
  const maxTabsIsCustom = !MAX_TABS_OPTIONS.includes(maxTabs)

  const handleSelectProvider = (value: string) => {
    const providerId = value === CONTAINER_VALUE ? null : value as HostBrowserProviderId
    setHostProvider(value)
    track('browser_host_changed', { using: value === CONTAINER_VALUE ? 'container' : value })
    updateSettings.mutate({
      app: { hostBrowserProvider: providerId as HostBrowserProviderId | undefined },
    })
  }

  // Rendered inside both the Browserbase and Platform cards — platform-managed
  // sessions run on Browserbase too, so the same session knobs apply.
  const sessionSettings = (
    <BrowserbaseSessionSettings
      advancedStealth={settings?.app?.browserbaseAdvancedStealth ?? false}
      stealthOs={settings?.app?.browserbaseStealthOs}
      proxies={settings?.app?.browserbaseProxies ?? false}
      proxyCountry={settings?.app?.browserbaseProxyCountry ?? ''}
      proxyState={settings?.app?.browserbaseProxyState ?? ''}
      proxyCity={settings?.app?.browserbaseProxyCity ?? ''}
      disabled={isLoading}
      onUpdate={(updates) => updateSettings.mutate({ app: updates })}
    />
  )

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Browser Agent</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Browser Agent Model"
            subtitle="Model used for the web browser subagent"
            right={
              <SettingsModelSelect
                model={settings?.models?.browserModel}
                onModelChange={(value) => updateSettings.mutate({ models: { browserModel: value } })}
                disabled={isLoading}
              />
            }
          />
          <SettingRow
            name="Max Browser Tabs"
            subtitle="Maximum number of browser tabs the agent can have open at once (default: 10)"
            htmlFor="max-browser-tabs"
            right={
              <Select
                value={String(maxTabs)}
                onValueChange={(value) => {
                  updateSettings.mutate({ app: { maxBrowserTabs: parseInt(value, 10) } })
                }}
                disabled={isLoading}
              >
                <SelectTrigger id="max-browser-tabs" className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {maxTabsIsCustom && (
                    <SelectItem value={String(maxTabs)}>{maxTabs} (custom)</SelectItem>
                  )}
                  {MAX_TABS_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </div>
      </div>

      {/* Host selection — radio cards, expanded card shows provider settings */}
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Browser Host</h3>
        <div role="radiogroup" aria-label="Browser host" className="space-y-3">
          <HostCard
            id={CONTAINER_VALUE}
            name="Container (built-in)"
            description={HOST_DESCRIPTIONS[CONTAINER_VALUE]}
            selected={effectiveProvider === CONTAINER_VALUE}
            disabled={isLoading}
            onSelect={() => handleSelectProvider(CONTAINER_VALUE)}
          />

          {providers.map((provider) => {
            const unavailable =
              !provider.available && (provider.id === 'chrome' || provider.id === 'platform')
            return (
              <HostCard
                key={provider.id}
                id={provider.id}
                name={provider.name}
                description={HOST_DESCRIPTIONS[provider.id]}
                selected={effectiveProvider === provider.id}
                disabled={unavailable || isLoading}
                disabledReason={unavailable ? provider.reason : undefined}
                onSelect={() => handleSelectProvider(provider.id)}
              >
                {provider.id === 'chrome' ? (
                  <div className="space-y-4">
                    {chromeProfiles.length > 0 && (
                      <FieldRow
                        name="Chrome Profile"
                        subtitle="Browse with an existing profile's logins and cookies"
                        htmlFor="chrome-profile-select"
                        stack
                        right={
                          <div className="w-full md:w-[260px]">
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
                          </div>
                        }
                      />
                    )}
                    <FieldRow
                      name="Headless Mode"
                      subtitle="Run Chrome without a visible window. Prevents Chrome from stealing focus."
                      htmlFor="chrome-headless"
                      right={
                        <Switch
                          id="chrome-headless"
                          checked={settings?.app?.chromeHeadless ?? false}
                          onCheckedChange={(checked) => {
                            updateSettings.mutate({ app: { chromeHeadless: checked } })
                          }}
                          disabled={isLoading}
                        />
                      }
                    />
                  </div>
                ) : provider.id === 'browserbase' ? (
                  <div className="space-y-4">
                    <BrowserbaseSettings
                      layout="rows"
                      apiKey={browserbaseApiKey}
                      projectId={browserbaseProjectId}
                      onApiKeyChange={(v) => { setBrowserbaseApiKey(v); setValidationResult(null) }}
                      onProjectIdChange={(v) => { setBrowserbaseProjectId(v); setValidationResult(null) }}
                      isValidating={isValidating}
                      validationResult={validationResult}
                      hasSavedCredentials={
                        !!providers.find((p) => p.id === 'browserbase')?.available
                        || !!settings?.apiKeyStatus?.browserbase?.isConfigured
                      }
                      credentialSource={settings?.apiKeyStatus?.browserbase?.source}
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
                    {sessionSettings}
                  </div>
                ) : provider.id === 'platform' ? (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">
                      Browser sessions run on Browserbase using your Platform account&apos;s
                      credentials — no API key configuration needed.
                    </p>
                    {sessionSettings}
                  </div>
                ) : null}
              </HostCard>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const STEALTH_OS_OPTIONS: Array<{ value: BrowserbaseStealthOs; label: string }> = [
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
  { value: 'mac', label: 'macOS' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'tablet', label: 'Tablet' },
]

const NO_OS_VALUE = '__none__'

interface BrowserbaseSessionSettingsProps {
  advancedStealth: boolean
  stealthOs?: BrowserbaseStealthOs
  proxies: boolean
  proxyCountry: string
  proxyState: string
  proxyCity: string
  disabled: boolean
  onUpdate: (updates: Partial<{
    browserbaseAdvancedStealth: boolean
    browserbaseStealthOs: BrowserbaseStealthOs | undefined
    browserbaseProxies: boolean
    browserbaseProxyCountry: string
    browserbaseProxyState: string
    browserbaseProxyCity: string
  }>) => void
}

/** Browserbase session config, rendered inside the expanded host card — used by
    both the Browserbase card (below credentials) and the Platform card. */
function BrowserbaseSessionSettings({
  advancedStealth,
  stealthOs,
  proxies,
  proxyCountry,
  proxyState,
  proxyCity,
  disabled,
  onUpdate,
}: BrowserbaseSessionSettingsProps) {
  return (
    <div className="space-y-4">
      <FieldRow
        name="Advanced Stealth Mode"
        subtitle="Uses a custom Chromium browser to avoid bot detection. Requires Scale plan."
        htmlFor="bb-stealth"
        right={
          <Switch
            id="bb-stealth"
            checked={advancedStealth}
            onCheckedChange={(checked) => {
              onUpdate({
                browserbaseAdvancedStealth: checked,
                // Clear OS when disabling stealth
                ...(!checked && { browserbaseStealthOs: undefined }),
              })
            }}
            disabled={disabled}
          />
        }
      />

      {/* OS Selection (only when stealth is on) */}
      {advancedStealth && (
        <FieldRow
          name="Operating System"
          subtitle="Changes the user agent and browser environment signals to match the selected platform"
          htmlFor="bb-stealth-os"
          right={
            <Select
              value={stealthOs ?? NO_OS_VALUE}
              onValueChange={(value) => {
                onUpdate({
                  browserbaseStealthOs: value === NO_OS_VALUE ? undefined : value as BrowserbaseStealthOs,
                })
              }}
              disabled={disabled}
            >
              <SelectTrigger id="bb-stealth-os" className="h-8 w-[160px]">
                <SelectValue placeholder="Default (auto)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OS_VALUE}>Default (auto)</SelectItem>
                {STEALTH_OS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      )}

      <FieldRow
        name="Enable Proxies"
        subtitle="Route traffic through residential proxies for higher CAPTCHA success rates and geo-targeting"
        htmlFor="bb-proxies"
        right={
          <Switch
            id="bb-proxies"
            checked={proxies}
            onCheckedChange={(checked) => {
              onUpdate({
                browserbaseProxies: checked,
                // Clear geolocation when disabling
                ...(!checked && {
                  browserbaseProxyCountry: '',
                  browserbaseProxyState: '',
                  browserbaseProxyCity: '',
                }),
              })
            }}
            disabled={disabled}
          />
        }
      />

      {/* Proxy Geolocation (only when proxies are on) */}
      {proxies && (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Optionally specify a proxy location. Leave empty for best-effort US proxy.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="bb-proxy-country" className="text-xs">Country Code</Label>
              <Input
                id="bb-proxy-country"
                placeholder="e.g. US"
                value={proxyCountry}
                onChange={(e) => onUpdate({ browserbaseProxyCountry: e.target.value.toUpperCase() })}
                disabled={disabled}
                maxLength={2}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bb-proxy-state" className="text-xs">State</Label>
              <Input
                id="bb-proxy-state"
                placeholder="e.g. NY"
                value={proxyState}
                onChange={(e) => onUpdate({ browserbaseProxyState: e.target.value.toUpperCase() })}
                disabled={disabled}
                maxLength={2}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bb-proxy-city" className="text-xs">City</Label>
              <Input
                id="bb-proxy-city"
                placeholder="e.g. NEW_YORK"
                value={proxyCity}
                onChange={(e) => onUpdate({ browserbaseProxyCity: e.target.value.toUpperCase() })}
                disabled={disabled}
                className="h-8"
              />
            </div>
          </div>
        </div>
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
  credentialSource?: 'settings' | 'env' | 'none'
  disabled: boolean
  onValidateAndSave: () => void
  onRemove: () => void
  /** 'rows' puts label + supporting text left, input right (settings tab).
      'stacked' (default) keeps label-above-input for narrow containers
      like the setup wizard's 480px column. */
  layout?: 'stacked' | 'rows'
}

export function BrowserbaseSettings({
  apiKey,
  projectId,
  onApiKeyChange,
  onProjectIdChange,
  isValidating,
  validationResult,
  hasSavedCredentials,
  credentialSource,
  disabled,
  onValidateAndSave,
  onRemove,
  layout = 'stacked',
}: BrowserbaseSettingsProps) {
  const hasInput = apiKey.trim().length > 0 && projectId.trim().length > 0
  const rows = layout === 'rows'

  const apiKeyInput = (
    <Input
      id="browserbase-api-key"
      type="password"
      placeholder={hasSavedCredentials ? '••••••••••••••••' : 'bb-api-...'}
      value={apiKey}
      onChange={(e) => onApiKeyChange(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', rows && 'h-8 w-full md:w-[340px]')}
    />
  )
  const projectIdInput = (
    <Input
      id="browserbase-project-id"
      type="text"
      placeholder={hasSavedCredentials ? '••••••••••••••••' : 'bb-proj-...'}
      value={projectId}
      onChange={(e) => onProjectIdChange(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', rows && 'h-8 w-full md:w-[340px]')}
    />
  )

  return (
    <div className="space-y-4">
      {hasSavedCredentials && (
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
            {credentialSource === 'env' ? 'Using environment variable' : 'Credentials saved'}
          </span>
        </div>
      )}

      {rows ? (
        <>
          <FieldRow
            name="API Key"
            subtitle="Secret key from your Browserbase dashboard"
            htmlFor="browserbase-api-key"
            stack
            right={apiKeyInput}
          />
          <FieldRow
            name="Project ID"
            subtitle="Found in your Browserbase project settings"
            htmlFor="browserbase-project-id"
            stack
            right={projectIdInput}
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="browserbase-api-key" className="font-normal text-muted-foreground">Browserbase API Key</Label>
            {apiKeyInput}
          </div>
          <div className="space-y-2">
            <Label htmlFor="browserbase-project-id" className="font-normal text-muted-foreground">Browserbase Project ID</Label>
            {projectIdInput}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        {hasInput && (
          <Button size="sm" onClick={onValidateAndSave} disabled={isValidating}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Connect'
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

      {validationResult && !validationResult.valid && (
        <RequestError message={validationResult.error || 'Invalid credentials'} />
      )}
      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          Credentials saved
        </p>
      )}
    </div>
  )
}
