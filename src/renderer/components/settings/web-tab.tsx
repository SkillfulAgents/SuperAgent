import { type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { WebProviderId } from '@shared/lib/config/settings'
import { ProviderApiKeyInput } from './provider-api-key-input'

const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

const WEB_PROVIDERS: {
  value: WebProviderId
  label: string
  note: string
  docsUrl?: string
  platformOnly?: boolean
}[] = [
  {
    value: 'platform',
    label: 'Gamut',
    note: 'Web search and full page reading, included with your Gamut plan. Nothing to set up.',
    platformOnly: true,
  },
  {
    value: 'exa',
    label: 'Exa',
    note: 'Web search and full page reading. Works with every model. Bring your own Exa API key.',
    docsUrl: 'https://docs.exa.ai',
  },
  {
    value: 'native',
    label: 'Native',
    note: "Uses the model's built-in web tools. Nothing to set up, but not all models have them.",
  },
]

interface ProviderCardProps {
  id: string
  name: string
  /** Rendered next to the name, e.g. the "(default)" marker. */
  nameSuffix?: ReactNode
  description?: ReactNode
  selected: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  children?: ReactNode
}

/** Radio card that expands its provider-specific settings when selected —
    mirrors ProviderCard from the LLM provider tab. */
function ProviderCard({
  id,
  name,
  nameSuffix,
  description,
  selected,
  disabled = false,
  disabledReason,
  onSelect,
  children,
}: ProviderCardProps) {
  return (
    <div
      className={`rounded-xl border bg-background transition-colors ${
        selected ? 'border-primary' : disabled ? 'opacity-60' : 'hover:border-muted-foreground/40'
      }`}
      data-testid={`web-provider-card-${id}`}
    >
      {/* A div rather than a <button>: descriptions may carry a real link, and
          interactive content inside a button is invalid HTML. */}
      <div
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onClick={disabled ? undefined : onSelect}
        onKeyDown={(e) => {
          if (disabled) return
          // Ignore keys bubbling from inner interactive content (e.g. links).
          if (e.target !== e.currentTarget) return
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            onSelect()
          }
        }}
        className={`w-full flex items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        }`}
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
            {nameSuffix}
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
      </div>

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

export function WebTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false

  const selected: WebProviderId = settings?.webProvider ?? 'native'
  const isDefault = settings?.webProviderIsDefault ?? true

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Web Provider</h3>
        <p className="text-[11px] text-muted-foreground px-1">
          How your agents search the web and read pages. If you don&apos;t pick one, Gamut is
          used when you&apos;re signed in; otherwise Native.
        </p>
        <div role="radiogroup" aria-label="Web provider" className="space-y-3 pt-1">
          {WEB_PROVIDERS.map((provider) => {
            const gated = !!provider.platformOnly && !isPlatformConnected
            const isSelected = selected === provider.value
            return (
              <ProviderCard
                key={provider.value}
                id={provider.value}
                name={provider.label}
                nameSuffix={
                  isSelected && isDefault ? (
                    <span className="text-xs text-muted-foreground">(default)</span>
                  ) : undefined
                }
                description={
                  <>
                    {provider.note}
                    {provider.docsUrl && (
                      <>
                        {' '}
                        <a
                          href={provider.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View Exa docs
                        </a>
                      </>
                    )}
                  </>
                }
                selected={isSelected}
                disabled={gated || isLoading}
                disabledReason={gated ? 'Requires Gamut account' : undefined}
                onSelect={() => updateSettings.mutate({ webProvider: provider.value })}
              >
                {provider.value === 'exa' ? (
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
                ) : null}
              </ProviderCard>
            )
          })}
        </div>
      </div>
    </div>
  )
}
