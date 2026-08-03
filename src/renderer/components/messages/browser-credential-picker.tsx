import { useCallback, useEffect, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useDialogs } from '@renderer/context/dialog-context'
import { useUser } from '@renderer/context/user-context'

interface CredentialSuggestion {
  id: string
  username: string
  domain: string
  title?: string
}

interface CredentialSuggestionsResponse {
  provider: string
  providerLabel: string
  status: 'unconfigured' | 'ready' | 'unavailable' | 'locked' | 'error'
  installable: boolean
  origin: string
  message?: string
  suggestions: CredentialSuggestion[]
}

interface VerificationRequest {
  type: 'numeric_code'
  length: number
  message: string
}

interface BrowserCredentialPickerProps {
  agentSlug: string
  sessionId: string
  toolUseId: string
  disabled?: boolean
}

export function BrowserCredentialPicker({
  agentSlug,
  sessionId,
  toolUseId,
  disabled,
}: BrowserCredentialPickerProps) {
  const { openSettings } = useDialogs()
  const { isAuthMode, isAdmin } = useUser()
  const canUsePasswordManagers = !isAuthMode || isAdmin
  const [data, setData] = useState<CredentialSuggestionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [fillingId, setFillingId] = useState<string | null>(null)
  const [filled, setFilled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [checking, setChecking] = useState(false)
  const [verification, setVerification] = useState<VerificationRequest | null>(null)
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!canUsePasswordManagers) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const refreshQuery = reload > 0 ? '&refresh=true' : ''
    void apiFetch(
      `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}` +
        `/browser-credentials?toolUseId=${encodeURIComponent(toolUseId)}${refreshQuery}`,
      { signal: controller.signal },
    ).then(async (response) => {
      const result = await response.json() as CredentialSuggestionsResponse & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not load saved credentials')
      setData(result)
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Could not load saved credentials')
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [agentSlug, canUsePasswordManagers, sessionId, toolUseId, reload])

  const fill = useCallback(async (credentialId: string) => {
    setFillingId(credentialId)
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}` +
          '/autofill-browser-credential',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, credentialId }),
        },
      )
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Credential autofill failed')
      setFilled(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Credential autofill failed')
    } finally {
      setFillingId(null)
    }
  }, [agentSlug, sessionId, toolUseId])

  const checkPasswordManager = useCallback(async () => {
    if (!data || data.provider === 'none') return
    setChecking(true)
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}` +
          '/browser-credentials/check',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, provider: data.provider }),
        },
      )
      const result = await response.json() as {
        error?: string
        status?: 'connected' | 'verification_required'
        verification?: VerificationRequest
      }
      if (!response.ok) throw new Error(result.error || `Could not check ${data.providerLabel}`)
      if (result.status === 'verification_required' && result.verification) {
        setCode('')
        setVerification(result.verification)
      } else {
        setReload((value) => value + 1)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not check ${data.providerLabel}`)
    } finally {
      setChecking(false)
    }
  }, [agentSlug, data, sessionId, toolUseId])

  const verifyPasswordManager = useCallback(async () => {
    if (!data || !verification || code.length !== verification.length) return
    setChecking(true)
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}` +
          '/browser-credentials/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, provider: data.provider, code }),
        },
      )
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'The verification code was rejected')
      setCode('')
      setVerification(null)
      setReload((value) => value + 1)
    } catch (reason) {
      setCode('')
      setVerification(null)
      setError(reason instanceof Error ? reason.message : 'The verification code was rejected')
    } finally {
      setChecking(false)
    }
  }, [agentSlug, code, data, sessionId, toolUseId, verification])

  if (!canUsePasswordManagers) return null
  if (!loading && data?.status === 'ready' && data.suggestions.length === 0 && !error) return null
  if (!loading && data?.status === 'unconfigured' && !data.installable) return null
  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="credential-picker-loading">
        <KeyRound className="h-3.5 w-3.5" />
        Checking saved credentials…
      </div>
    )
  }

  if (filled) {
    return (
      <div className="mt-3 rounded-md border border-green-500/30 bg-green-500/5 p-3 text-xs" data-testid="credential-picker-filled">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5 text-green-600" />
          Credentials filled
        </div>
        <p className="mt-1 text-muted-foreground">Continue signing in in the browser.</p>
      </div>
    )
  }

  if (data?.status === 'unconfigured') {
    return (
      <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="credential-picker-status">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          Password manager
        </div>
        <p className="mt-1 text-muted-foreground">
          Connect a password manager in Browser Use settings to fill saved logins.
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={() => openSettings('browser')}
          disabled={disabled}
        >
          <KeyRound className="mr-1 h-3 w-3" />
          Connect Password Manager
        </Button>
      </div>
    )
  }

  if (data?.status === 'locked') {
    return (
      <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="credential-picker-status">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          {data.providerLabel}
        </div>
        <p className="mt-1 text-muted-foreground">
          Check your password manager to show saved logins for this page.
        </p>
        {verification ? (
          <form
            className="mt-2"
            onSubmit={(event) => {
              event.preventDefault()
              void verifyPasswordManager()
            }}
          >
            <p className="mb-2 text-muted-foreground">{verification.message}</p>
            <div className="flex items-center gap-2">
              <Input
                value={code}
                onChange={(event) => setCode(
                  event.target.value.replace(/\D/g, '').slice(0, verification.length),
                )}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={verification.length}
                autoFocus
                placeholder={'0'.repeat(verification.length)}
                aria-label={`${data.providerLabel} verification code`}
                className="h-8 max-w-32 font-mono tracking-[0.25em]"
                disabled={checking || disabled}
              />
              <Button
                type="submit"
                size="xs"
                loading={checking}
                disabled={disabled || code.length !== verification.length}
              >
                Verify
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={() => void checkPasswordManager()}
            loading={checking}
            disabled={disabled}
          >
            <KeyRound className="mr-1 h-3 w-3" />
            Check Password Manager
          </Button>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (data?.status === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="credential-picker-status">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          {data.providerLabel}
        </div>
        <p className="mt-1 text-muted-foreground">{data.message || 'The password manager is unavailable.'}</p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={() => openSettings('browser')}
          disabled={disabled}
        >
          Manage Password Manager
        </Button>
      </div>
    )
  }

  if (data?.status === 'error') {
    return (
      <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="credential-picker-status">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          {data.providerLabel}
        </div>
        <p className="mt-1 text-muted-foreground">{data.message || 'The password manager is not ready.'}</p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={() => setReload((value) => value + 1)}
          disabled={disabled}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Retry
        </Button>
      </div>
    )
  }

  if (!data || (error && data.suggestions.length === 0)) {
    return error ? (
      <div className="mt-2 flex items-center gap-2 text-xs">
        <p className="text-destructive">{error}</p>
        <Button type="button" size="xs" variant="ghost" onClick={() => setReload((value) => value + 1)}>
          <RefreshCw className="mr-1 h-3 w-3" />
          Retry
        </Button>
      </div>
    ) : null
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3" data-testid="credential-picker">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <KeyRound className="h-3.5 w-3.5" />
        Fill from {data.providerLabel}
      </div>
      <div className="mt-2 space-y-1.5">
        {data.suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            className="flex w-full items-center gap-3 rounded-md border border-border bg-background px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50"
            onClick={() => fill(suggestion.id)}
            disabled={disabled || fillingId !== null}
            data-testid={`credential-suggestion-${suggestion.id}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">
                {suggestion.username || suggestion.title || 'Saved login'}
              </span>
              <span className="block truncate text-2xs text-muted-foreground">
                {suggestion.title && suggestion.username ? `${suggestion.title} · ` : ''}{suggestion.domain}
              </span>
            </span>
            <span className="text-2xs font-medium text-blue-600 dark:text-blue-400">
              {fillingId === suggestion.id ? 'Filling…' : 'Fill'}
            </span>
          </button>
        ))}
      </div>
      {error && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-destructive">{error}</p>
          <Button type="button" size="xs" variant="ghost" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>
      )}
    </div>
  )
}
