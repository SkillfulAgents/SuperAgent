import { useEffect, useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { copyTextToClipboard } from '@renderer/lib/clipboard'
import { Button } from '@renderer/components/ui/button'
import { apiFetch } from '@renderer/lib/api'

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
  return <div className="rounded-lg bg-muted p-3 text-sm space-y-2">
    <p>{provider === 'codex' ? 'Sign in with the ChatGPT account that has your Codex subscription. Device code authentication must be enabled in your ChatGPT settings.' : 'Use your eligible Grok subscription. Choose the X or xAI account that has your subscription.'}</p>
    {provider === 'codex' && <p className="text-muted-foreground">App defaults using this provider need a separate API-capable summarizer. Fast mode uses more subscription credits.</p>}
    {accountLabel && <p>Signed in as <strong>{accountLabel}</strong></p>}
    {login && <div className="space-y-2">
      <div className="flex items-center gap-1">
        <p>Code: <strong className="font-mono select-all">{login.code}</strong></p>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Copy sign-in code" title="Copy sign-in code" onClick={() => {
          void copyTextToClipboard(login.code)
            .then(() => toast.success('Sign-in code copied'))
            .catch(() => toast.error('Could not copy code. Select and copy it manually.'))
        }}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <a className="underline" href={login.url} target="_blank" rel="noreferrer">Open {name} sign-in</a>
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Waiting for sign-in…
      </p>
    </div>}
    <Button type="button" variant="outline" disabled={busy} onClick={() => void start()}>
      {busy ? 'Starting sign-in…' : accountLabel ? `Reconnect ${name}` : login ? 'Get a new code' : `Sign in with ${name}`}
    </Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <p className="text-muted-foreground">Displayed costs are API-equivalent estimates, not subscription charges.</p>
  </div>
}
