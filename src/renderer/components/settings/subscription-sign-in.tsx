import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { apiFetch } from '@renderer/lib/api'
import { CopyableValue, SetupPanel, SetupSteps } from './setup-steps'

export function SubscriptionSignIn({ provider = 'grok', connectionId, userId, accountLabel, onConnected }: {
  provider?: 'grok' | 'codex'
  connectionId?: string
  userId: string | null
  accountLabel?: string
  onConnected: (id: string, label: string) => void
}) {
  const name = provider === 'codex' ? 'Codex' : 'Grok'
  const [login, setLogin] = useState<{ id: string; url: string; code: string; interval: number }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!login) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await apiFetch(`/api/llm-connections/oauth/${login.id}/poll`, { method: 'POST', signal: abort.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? 'Sign-in failed')
        if (abort.signal.aborted) return
        if (result.status === 'connected') {
          onConnected(login.id, result.accountLabel)
          setLogin(undefined)
        } else timer = setTimeout(() => void poll(), login.interval * 1000)
      } catch (error) {
        if (abort.signal.aborted) return
        setError(error instanceof Error ? error.message : 'Sign-in failed')
        setLogin(undefined)
      }
    }
    timer = setTimeout(() => void poll(), login.interval * 1000)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [login, onConnected])
  const start = async () => {
    setBusy(true); setError(''); setLogin(undefined)
    try {
      const response = await apiFetch(`/api/llm-connections/oauth/${provider}/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: connectionId, userId }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Could not start sign-in')
      setLogin(result)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not start sign-in') }
    finally { setBusy(false) }
  }
  const account = provider === 'codex' ? 'ChatGPT account' : 'X or xAI account'
  const notes = [
    provider === 'codex' && 'Pick a separate API-capable summarizer if this becomes the app default. Fast mode uses more subscription credits.',
  ]
  const signInButton = (
    <Button type="button" className="mt-2 w-fit" disabled={busy} onClick={() => void start()}>
      {busy ? 'Starting sign-in…' : `Sign in with ${name}`}
    </Button>
  )
  return <SetupPanel notes={notes}>
    {login ? (
      <SetupSteps steps={[
        <>
          <span>Copy your sign-in code:</span>
          <CopyableValue value={login.code} label="Copy sign-in code" large />
        </>,
        <>
          <span>Open the {name} sign-in page and enter the code.</span>
          <a
            className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
            href={login.url}
            target="_blank"
            rel="noreferrer"
          >
            Open {name} sign-in
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </a>
        </>,
        <span key="status" className="flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Waiting for you to finish signing in…
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting sign-in…' : 'Get a new code'}
          </Button>
        </span>,
      ]} />
    ) : accountLabel ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden="true" />
          <span className="truncate">Signed in as <span className="font-medium">{accountLabel}</span></span>
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting sign-in…' : `Reconnect ${name}`}
        </Button>
      </div>
    ) : provider === 'codex' ? (
      <SetupSteps steps={[
        'Turn on device code authentication in your ChatGPT settings.',
        <>
          <span>Sign in with the {account} that has your {name} subscription.</span>
          {signInButton}
        </>,
      ]} />
    ) : (
      <div className="space-y-3">
        <p>Sign in with the {account} that has your {name} subscription.</p>
        {signInButton}
      </div>
    )}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </SetupPanel>
}
