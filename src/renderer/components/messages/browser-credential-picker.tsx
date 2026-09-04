import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useDialogs } from '@renderer/context/dialog-context'
import { useUser } from '@renderer/context/user-context'
import {
  credentialSuggestionsResponseSchema,
  type CredentialSuggestionsResponse,
} from '@shared/lib/credentials/schemas'
import { siteNameQuery } from '@shared/lib/onepassword/credential-index'

type CredentialSuggestion = CredentialSuggestionsResponse['suggestions'][number]

function suggestionPrimary(suggestion: CredentialSuggestion): string {
  return suggestion.username || suggestion.title || 'Saved login'
}

function suggestionSubtext(suggestion: CredentialSuggestion): string {
  const primary = suggestionPrimary(suggestion)
  return [suggestion.title !== primary ? suggestion.title : null, suggestion.domain]
    .filter(Boolean)
    .join(' · ')
}

type SuggestionsFetchResult = { kind: 'ok' } | { kind: 'terminal' } | { kind: 'failed' }

interface VerificationRequest {
  type: 'numeric_code'
  length: number
  message: string
}

interface ManualCredential {
  username: string
  password: string
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
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [settled, setSettled] = useState(false)
  const [checking, setChecking] = useState(false)
  const [verification, setVerification] = useState<VerificationRequest | null>(null)
  const [code, setCode] = useState('')
  const [manualCredential, setManualCredential] = useState<ManualCredential | null>(null)
  const [passwordRevealed, setPasswordRevealed] = useState(false)
  const [copiedField, setCopiedField] = useState<'username' | 'password' | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copiedResetTimer = useRef<number | null>(null)

  const clearCopiedResetTimer = useCallback(() => {
    if (copiedResetTimer.current !== null) {
      window.clearTimeout(copiedResetTimer.current)
      copiedResetTimer.current = null
    }
  }, [])

  const queryRef = useRef(debouncedQuery)
  queryRef.current = debouncedQuery
  const previousQuery = useRef<string | null>(null)
  const appliedSiteNameSearch = useRef(false)

  useEffect(() => {
    return () => clearCopiedResetTimer()
  }, [clearCopiedResetTimer])

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), 300)
    return () => window.clearTimeout(handle)
  }, [query])

  const loadSuggestions = useCallback(async ({
    background,
    refresh,
    q,
    signal,
  }: {
    background: boolean
    refresh: boolean
    q: string
    signal: AbortSignal
  }): Promise<SuggestionsFetchResult> => {
    if (!background) {
      setLoading(true)
      setError(null)
      setFilled(false)
      setManualCredential(null)
      setPasswordRevealed(false)
      clearCopiedResetTimer()
      setCopiedField(null)
      setCopyError(null)
    }
    const refreshQuery = refresh ? '&refresh=true' : ''
    const qQuery = q ? `&q=${encodeURIComponent(q)}` : ''
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}` +
          `/browser-credentials?toolUseId=${encodeURIComponent(toolUseId)}${refreshQuery}${qQuery}`,
        { signal },
      )
      const result = await response.json() as { error?: string }
      if (response.status === 404) {
        setSettled(true)
        setData(null)
        setError(null)
        return { kind: 'terminal' }
      }
      if (!response.ok) throw new Error(result.error || 'Could not load saved credentials')
      const parsed = credentialSuggestionsResponseSchema.safeParse(result)
      if (!parsed.success) throw new Error('Could not load saved credentials')
      setData(parsed.data)
      if (background) setError(null)
      return { kind: 'ok' }
    } catch (reason: unknown) {
      if (signal.aborted) return { kind: 'failed' }
      setError(reason instanceof Error ? reason.message : 'Could not load saved credentials')
      return { kind: 'failed' }
    } finally {
      if (!background && !signal.aborted) setLoading(false)
    }
  }, [agentSlug, clearCopiedResetTimer, sessionId, toolUseId])

  useEffect(() => {
    if (!canUsePasswordManagers) {
      setLoading(false)
      return
    }
    if (settled) return
    const controller = new AbortController()
    void loadSuggestions({
      background: false,
      refresh: reload > 0,
      q: queryRef.current,
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [agentSlug, canUsePasswordManagers, loadSuggestions, reload, sessionId, settled, toolUseId])

  useEffect(() => {
    if (!canUsePasswordManagers || settled) return
    if (previousQuery.current === null) {
      previousQuery.current = debouncedQuery
      return
    }
    if (previousQuery.current === debouncedQuery) return
    previousQuery.current = debouncedQuery
    const controller = new AbortController()
    void loadSuggestions({
      background: true,
      refresh: false,
      q: debouncedQuery,
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [canUsePasswordManagers, debouncedQuery, loadSuggestions, settled])

  useEffect(() => {
    if (appliedSiteNameSearch.current || settled) return
    if (data?.status !== 'ready' || !data.searchable) return
    if (data.suggestions.length > 0 || query) return
    const label = siteNameQuery(data.origin)
    if (!label) return
    appliedSiteNameSearch.current = true
    setQuery(label)
  }, [data, query, settled])

  useEffect(() => {
    if (data?.status !== 'warming' || settled) return
    const controller = new AbortController()
    const interval = window.setInterval(() => {
      void loadSuggestions({
        background: true,
        refresh: false,
        q: '',
        signal: controller.signal,
      }).then((result) => {
        if (result.kind === 'terminal') controller.abort()
      })
    }, 5000)
    return () => {
      window.clearInterval(interval)
      controller.abort()
    }
  }, [data?.status, loadSuggestions, settled])

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
      const result = await response.json() as {
        error?: string
        reason?: string
        manualCredential?: ManualCredential
      }
      if (!response.ok && result.reason === 'no_password_field' && result.manualCredential) {
        setManualCredential(result.manualCredential)
        return
      }
      if (!response.ok) throw new Error(result.error || 'Credential autofill failed')
      setFilled(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Credential autofill failed')
    } finally {
      setFillingId(null)
    }
  }, [agentSlug, sessionId, toolUseId])

  const copyManualCredential = useCallback(async (field: 'username' | 'password') => {
    if (!manualCredential) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(manualCredential[field])
      setCopyError(null)
      setCopiedField(field)
      clearCopiedResetTimer()
      copiedResetTimer.current = window.setTimeout(() => {
        setCopiedField((current) => current === field ? null : current)
        copiedResetTimer.current = null
      }, 2000)
    } catch {
      setCopyError('Could not copy automatically. Reveal and select the value instead.')
    }
  }, [clearCopiedResetTimer, manualCredential])

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
  if (
    !loading
    && data?.status === 'ready'
    && data.suggestions.length === 0
    && !data.searchable
    && !query
    && !error
  ) return null
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

  if (manualCredential) {
    return (
      <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs" data-testid="credential-picker-manual">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-3.5 w-3.5 text-amber-600" />
          Copy saved login
        </div>
        <p className="mt-1 text-muted-foreground">
          Autofill couldn&apos;t reach this page&apos;s sign-in fields. Copy and paste each value in the browser, then click Done.
        </p>
        <div className="mt-3 space-y-2">
          <div>
            <p className="mb-1 text-2xs font-medium text-muted-foreground">Username</p>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 select-all truncate rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                {manualCredential.username || '(empty)'}
              </code>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void copyManualCredential('username')}
                aria-label="Copy username"
                disabled={disabled}
              >
                {copiedField === 'username' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span className="ml-1">{copiedField === 'username' ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>
          <div>
            <p className="mb-1 text-2xs font-medium text-muted-foreground">Password</p>
            <div className="flex items-center gap-1.5">
              <code
                className="min-w-0 flex-1 select-all truncate rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                aria-hidden="true"
              >
                {passwordRevealed ? manualCredential.password : '••••••••••••'}
              </code>
              <span className="sr-only" aria-live="polite">
                {passwordRevealed ? `Password: ${manualCredential.password}` : 'Password hidden'}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setPasswordRevealed((value) => !value)}
                aria-label={passwordRevealed ? 'Hide password' : 'Show password'}
                disabled={disabled}
              >
                {passwordRevealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void copyManualCredential('password')}
                aria-label="Copy password"
                disabled={disabled}
              >
                {copiedField === 'password' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span className="ml-1">{copiedField === 'password' ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>
        </div>
        {copyError && <p className="mt-2 text-destructive">{copyError}</p>}
        <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setReload((value) => value + 1)}
            disabled={disabled}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Retry
          </Button>
          <p className="text-2xs text-muted-foreground">
            Refresh saved logins, then select this login again.
          </p>
        </div>
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

  if (data?.status === 'warming') {
    return (
      <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="credential-picker-warming">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {data.providerLabel}
        </div>
        <p className="mt-1 text-muted-foreground">
          Loading your saved logins.
        </p>
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
          {data.message || 'Check your password manager to show saved logins for this page.'}
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

  const showSearchInput = data.searchable && (
    searchOpen || data.suggestions.length === 0 || Boolean(query)
  )
  const searchFoundNothing = Boolean(debouncedQuery)
    && query === debouncedQuery
    && data.searchable
    && data.suggestions.length === 0

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3" data-testid="credential-picker">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <KeyRound className="h-3.5 w-3.5" />
        Fill from {data.providerLabel}
      </div>
      {data.searchable && data.suggestions.length === 0 && !query && (
        <p className="mt-1 text-xs text-muted-foreground">
          No saved logins matched this page. Search your vault by name.
        </p>
      )}
      {searchFoundNothing && (
        <p className="mt-1 text-xs text-muted-foreground">
          No logins matched “{query}”
        </p>
      )}
      <div className="mt-2 space-y-1.5">
        {data.suggestions.map((suggestion) => {
          const primary = suggestionPrimary(suggestion)
          const subtext = suggestionSubtext(suggestion)
          return (
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
                  {primary}
                </span>
                {subtext ? (
                  <span className="block truncate text-2xs text-muted-foreground">
                    {subtext}
                  </span>
                ) : null}
              </span>
              <span className="text-2xs font-medium text-blue-600 dark:text-blue-400">
                {fillingId === suggestion.id ? 'Filling…' : 'Fill'}
              </span>
            </button>
          )
        })}
      </div>
      {showSearchInput ? (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your 1Password logins…"
          aria-label="Search your 1Password logins"
          className="mt-2 h-8"
        />
      ) : data.searchable ? (
        <button
          type="button"
          className="mt-2 text-2xs text-muted-foreground hover:text-foreground"
          onClick={() => setSearchOpen(true)}
        >
          Search 1Password for a different login…
        </button>
      ) : null}
      {searchFoundNothing && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-2"
          onClick={() => openSettings('browser')}
          disabled={disabled}
        >
          Switch password manager
        </Button>
      )}
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
