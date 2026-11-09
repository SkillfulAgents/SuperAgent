import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { signIn } from '@renderer/lib/auth-client'
import { apiFetch } from '@renderer/lib/api'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { INVITE_LINK_PARAM, type InviteDetails } from '@shared/lib/team-directory/invite-schema'

/** The token of the invite link this page was opened from, if any. */
export function useInviteLinkToken(): string | null {
  return useMemo(() => new URLSearchParams(window.location.search).get(INVITE_LINK_PARAM), [])
}

/** Drops the token from the address bar once it has been used (or turned out stale). */
function forgetInviteLink() {
  const url = new URL(window.location.href)
  url.searchParams.delete(INVITE_LINK_PARAM)
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}

function passwordProblem(password: string, details: InviteDetails): string | null {
  if (password.length < details.passwordMinLength) return `Password must be at least ${details.passwordMinLength} characters`
  if (!details.passwordRequireComplexity) return null
  if (!/[a-z]/.test(password)) return 'Must contain a lowercase letter'
  if (!/[A-Z]/.test(password)) return 'Must contain an uppercase letter'
  if (!/[0-9]/.test(password)) return 'Must contain a number'
  if (!/[^a-zA-Z0-9]/.test(password)) return 'Must contain a symbol'
  return null
}

/**
 * Joining from a team-directory invite: the account already exists, with the
 * access and mentions waiting for them, and setting a password claims it.
 * Single sign-on (offered above this form) claims it as well, by email.
 */
export function InviteJoinForm({ token, onDone, onPendingApproval }: {
  token: string
  /** Back to the ordinary sign-in form. */
  onDone: () => void
  onPendingApproval?: (pending?: boolean) => void
}) {
  const [details, setDetails] = useState<InviteDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok) {
          setLoadError(body?.error ?? 'This invitation can’t be used.')
          forgetInviteLink()
          return
        }
        setDetails(body as InviteDetails)
        setName((body as InviteDetails).name)
      })
      .catch(() => { if (!cancelled) setLoadError('Couldn’t open this invitation. Try again.') })
    return () => { cancelled = true }
  }, [token])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!details) return
    const problem = !name.trim() ? 'Name is required' : passwordProblem(password, details) ?? (password !== confirm ? 'Passwords do not match' : null)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const res = await apiFetch('/api/auth/invite/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: name.trim(), password }),
      })
      const body = await res.json().catch(() => null) as { email?: string; pendingApproval?: boolean; error?: string } | null
      if (!res.ok || !body?.email) {
        setError(body?.error ?? 'Couldn’t join. Try again.')
        return
      }
      forgetInviteLink()
      if (body.pendingApproval) {
        onPendingApproval?.(true)
        setPending(true)
        return
      }
      const signedIn = await signIn.email({ email: body.email, password })
      if (signedIn.error) setError(signedIn.error.message || 'You joined, but signing in failed. Sign in with your new password.')
    } catch {
      setError('Couldn’t join. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (pending) {
    return (
      <div className="text-center space-y-3 py-4" data-testid="pending-approval">
        <h3 className="font-medium">Account Pending Approval</h3>
        <p className="text-sm text-muted-foreground">
          You’ve joined, and an admin needs to approve your account before you can sign in.
        </p>
        <Button variant="outline" onClick={() => { onPendingApproval?.(false); onDone() }}>Back to Sign In</Button>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="space-y-3" data-testid="invite-join-error">
        <Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert>
        <Button variant="outline" className="w-full" onClick={onDone}>Sign in</Button>
      </div>
    )
  }

  if (!details) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening your invitation...
      </div>
    )
  }

  const greeting = (
    <p className="text-center text-sm text-muted-foreground" data-testid="invite-join-greeting">
      {details.invitedBy ? `${details.invitedBy} invited you to Gamut.` : 'You’ve been invited to Gamut.'}{' '}
      Your shared agents and mentions are waiting.
    </p>
  )

  if (!details.passwordJoin) {
    return (
      <div className="space-y-3" data-testid="invite-join-sso">
        {greeting}
        <p className="text-center text-sm">Sign in with single sign-on as <strong>{details.email}</strong> to join.</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="invite-join-form">
      {greeting}
      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" type="email" value={details.email} readOnly disabled />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-name">Name</Label>
        <Input id="invite-name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-password">Password</Label>
        <Input
          id="invite-password"
          type="password"
          autoComplete="new-password"
          autoFocus
          placeholder={details.passwordRequireComplexity
            ? `At least ${details.passwordMinLength} chars, mixed case + number + symbol`
            : `At least ${details.passwordMinLength} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-confirm">Confirm Password</Label>
        <Input id="invite-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && (
        <Alert variant="destructive" data-testid="invite-join-form-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={submitting} data-testid="invite-join-submit">
        {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Joining...</> : 'Join Gamut'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already joined?{' '}
        <button type="button" onClick={onDone} className="text-primary underline">Sign in</button>
      </p>
    </form>
  )
}
