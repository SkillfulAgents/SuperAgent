import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Lock, RefreshCw } from 'lucide-react'
import { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import {
  passwordManagerCardSchema,
  type PasswordManagerCard,
} from '@shared/lib/credentials/schemas'

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'apple-passwords': 'Fill logins saved in Apple Passwords during browser tasks.',
  onepassword: 'Fill logins saved in 1Password during browser tasks.',
}

const DISCONNECTED_COPY: Record<string, string> = {
  'apple-passwords': 'You’ll enter a six-digit code from a login request when needed.',
  onepassword: 'You’ll approve access in the 1Password app when needed.',
}

function availabilityText(provider: PasswordManagerCard): string {
  if (provider.status === 'connected') return 'Available in this app session.'
  if (provider.status === 'disconnected') {
    return DISCONNECTED_COPY[provider.provider] || 'You’ll enter a six-digit code from a login request when needed.'
  }
  return provider.message || 'This password manager is not available on this device.'
}

type RemediationAction = NonNullable<NonNullable<PasswordManagerCard['remediation']>['action']>

async function openRemediation(action: RemediationAction) {
  if (action.kind === 'open_in_chrome' && window.electronAPI?.openApplePasswordsExtension) {
    await window.electronAPI.openApplePasswordsExtension()
    return
  }
  if (window.electronAPI?.openExternal) {
    await window.electronAPI.openExternal(action.url)
    return
  }
  window.open(action.url, '_blank', 'noopener,noreferrer')
}

const passwordManagersResponseSchema = z.object({
  providers: z.array(passwordManagerCardSchema),
})

export function PasswordManagersSettings() {
  const [providers, setProviders] = useState<PasswordManagerCard[]>([])
  const [loading, setLoading] = useState(true)
  const [workingProvider, setWorkingProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch('/api/settings/password-managers')
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not load password managers')
      const parsed = passwordManagersResponseSchema.parse(result)
      setProviders(parsed.providers)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load password managers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setConfigured = useCallback(async (provider: PasswordManagerCard) => {
    const configured = !provider.configured
    setWorkingProvider(provider.provider)
    setError(null)
    try {
      const response = await apiFetch(
        `/api/settings/password-managers/${encodeURIComponent(provider.provider)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ configured }),
        },
      )
      const result = await response.json() as {
        error?: string
        provider?: unknown
      }
      if (!response.ok) {
        const card = passwordManagerCardSchema.safeParse(result.provider)
        if (card.success) {
          setProviders((current) => current.map((candidate) =>
            candidate.provider === card.data.provider ? card.data : candidate
          ))
        }
        throw new Error(result.error || `Could not update ${provider.providerLabel}`)
      }
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not update ${provider.providerLabel}`)
    } finally {
      setWorkingProvider(null)
    }
  }, [load])

  return (
    <div id="password-managers" className="space-y-2" data-testid="password-managers-settings">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">Password Managers</h3>
      {loading && providers.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border bg-background px-4 py-3 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Checking password managers…
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border bg-background px-4 py-3 text-xs text-muted-foreground">
          No password managers are available on this device.
        </div>
      ) : (
        <div role="radiogroup" aria-label="Password managers" className="space-y-3">
          {providers.map((provider) => {
            const isWorking = workingProvider === provider.provider
            const unavailable = provider.status === 'unavailable' || provider.status === 'error'
            const disabled = loading || workingProvider !== null || (unavailable && !provider.configured)
            return (
              <div
                key={provider.provider}
                className={`rounded-xl border bg-background transition-colors ${
                  provider.configured
                    ? 'border-primary'
                    : disabled && !unavailable
                      ? 'opacity-60'
                      : 'hover:border-muted-foreground/40'
                }`}
                data-testid={`password-manager-${provider.provider}`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={provider.configured}
                  aria-disabled={disabled || undefined}
                  disabled={disabled}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
                  onClick={() => void setConfigured(provider)}
                >
                  <div
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                      provider.configured ? 'border-primary' : 'border-muted-foreground/40'
                    }`}
                    aria-hidden="true"
                  >
                    {provider.configured && <div className="h-2 w-2 rounded-full bg-primary" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{provider.providerLabel}</span>
                      {['apple-passwords', 'onepassword'].includes(provider.provider) && (
                        <span className="text-[11px] text-muted-foreground">Experimental</span>
                      )}
                      {unavailable && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Lock className="h-3 w-3" />
                          Unavailable
                        </span>
                      )}
                      {isWorking && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {PROVIDER_DESCRIPTIONS[provider.provider] || 'Fill saved logins during browser tasks.'}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {availabilityText(provider)}
                    </div>
                  </div>
                </button>
                {unavailable && (
                  <div className="border-t border-border/50 px-4 pb-4 pt-3">
                    <div className="text-xs font-medium">
                      {provider.remediation?.title || 'Could not validate this password manager'}
                    </div>
                    <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
                      {(provider.remediation?.instructions || [
                        'Click Refresh to check the local prerequisites again.',
                      ]).map((instruction) => (
                        <li key={instruction}>{instruction}</li>
                      ))}
                    </ol>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {provider.remediation?.action && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => void openRemediation(provider.remediation!.action!)}
                        >
                          <ExternalLink className="mr-1 h-3 w-3" />
                          {provider.remediation.action.label}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => void load()}
                        disabled={loading}
                      >
                        <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
