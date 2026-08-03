import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, Lock, RefreshCw } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'

interface PasswordManagerRemediation {
  code: string
  title: string
  instructions: string[]
  action?: {
    kind: 'open_url' | 'open_in_chrome'
    label: string
    url: string
  }
}

interface PasswordManagerConnection {
  provider: string
  providerLabel: string
  configured: boolean
  status: 'connected' | 'disconnected' | 'unavailable' | 'error'
  message?: string
  remediation?: PasswordManagerRemediation
}

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'apple-passwords': 'Fill logins saved in Apple Passwords during browser tasks.',
}

function availabilityText(provider: PasswordManagerConnection): string {
  if (provider.status === 'connected') return 'Available in this app session.'
  if (provider.status === 'disconnected') {
    return 'You’ll enter a six-digit code from a login request when needed.'
  }
  return provider.message || 'This password manager is not available on this device.'
}

async function openRemediation(action: NonNullable<PasswordManagerRemediation['action']>) {
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

export function PasswordManagersSettings() {
  const [providers, setProviders] = useState<PasswordManagerConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [workingProvider, setWorkingProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch('/api/settings/password-managers')
      const result = await response.json() as {
        error?: string
        providers?: PasswordManagerConnection[]
      }
      if (!response.ok) throw new Error(result.error || 'Could not load password managers')
      setProviders(result.providers || [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load password managers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setConfigured = useCallback(async (provider: PasswordManagerConnection) => {
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
        provider?: PasswordManagerConnection
      }
      if (!response.ok) {
        if (result.provider) {
          setProviders((current) => current.map((candidate) =>
            candidate.provider === result.provider?.provider ? result.provider : candidate
          ))
        }
        throw new Error(result.error || `Could not update ${provider.providerLabel}`)
      }
      setProviders((current) => current.map((candidate) =>
        candidate.provider === provider.provider ? { ...candidate, configured } : candidate
      ))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not update ${provider.providerLabel}`)
    } finally {
      setWorkingProvider(null)
    }
  }, [])

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
        <div role="group" aria-label="Password managers" className="space-y-3">
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
                  role="checkbox"
                  aria-checked={provider.configured}
                  aria-disabled={disabled || undefined}
                  disabled={disabled}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
                  onClick={() => void setConfigured(provider)}
                >
                  <div
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-2 ${
                      provider.configured ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                    }`}
                    aria-hidden="true"
                  >
                    {provider.configured && <Check className="h-3 w-3" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{provider.providerLabel}</span>
                      {provider.provider === 'apple-passwords' && (
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
