import { useEffect, useRef } from 'react'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'
import { RequestItemShell } from '../requests/request-item-shell'
import type { LoginFieldSummary, LoginVaultPayload } from './login-request'
import { siteLabel } from './login-request'
import { LoginForm } from './login-form'
import { loginRequestKey, useLoginRequestState } from './login-request-store'
import { useLoginContext } from './use-login-request'

interface LoginRequestItemProps {
  toolUseId: string
  message: string
  fields: LoginFieldSummary[]
  vault?: LoginVaultPayload
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

const STATUS_LABELS = {
  filled: 'Sent to the page',
  via: 'Signs in with another account',
  manual: 'Signed in on the page',
  declined: 'Declined',
  settled: 'Already answered',
} as const

/** The browser had closed before the user answered. */
function browserClosedLabel(saved: string | null): string {
  return saved ? 'Saved for the agent' : 'The browser had closed'
}

export function LoginRequestItem({
  toolUseId,
  message,
  fields,
  vault,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: LoginRequestItemProps) {
  const state = useLoginRequestState(loginRequestKey(agentSlug, sessionId, toolUseId))
  // Viewers who cannot answer do not read the form's context (they may not).
  const context = useLoginContext(agentSlug, sessionId, toolUseId, !readOnly)
  const origin = context.data?.origin ?? null
  const done = state.status === 'filled' || state.status === 'via' || state.status === 'manual' || state.status === 'declined' || state.status === 'settled' || state.status === 'browser_closed'
  // Here, not in the form: the shell swaps the form for its completed row in
  // the same render that settles the request, so the form never sees it.
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  useEffect(() => {
    if (done) onCompleteRef.current()
  }, [done])
  // The card leaves the stack as the request settles, so what went wrong in
  // the page is said where it outlives the card.
  const result = state.status === 'filled' ? state.result : null
  useEffect(() => {
    if (!result) return
    if (result.saveError) toast.error('The account was not saved', { description: result.saveError })
    if (result.filled === 0 || result.problems.length > 0) {
      toast.warning(result.filled === 0 ? 'Nothing was filled on the page' : 'Not everything went into the page', {
        description: result.problems.join(' ') || 'The agent has been told what the page showed.',
      })
    }
  }, [result])
  const closedSaved = state.status === 'browser_closed' ? state.saved : undefined
  useEffect(() => {
    if (closedSaved === undefined) return
    if (closedSaved) toast.success(`${closedSaved} is saved`, { description: 'The browser had closed, so nothing went into the page. The agent opens it again and signs in with this.' })
    else toast.warning('The browser had closed', { description: 'Nothing went into the page, and nothing was saved. The agent opens it again and asks you.' })
  }, [closedSaved])

  return (
    <RequestItemShell
      // The site comes from the browser, never from the agent: it is the
      // one thing a person must read before typing a password.
      title={origin ? `Sign in to ${siteLabel(origin)}` : 'Sign in'}
      subtitle={message}
      theme="blue"
      sessionId={sessionId}
      agentSlug={agentSlug}
      waitingText="Waiting for sign-in"
      completed={
        done
          ? {
              icon: (
                <KeyRound
                  className={cn('h-4 w-4 shrink-0', state.status === 'declined' ? 'text-red-500' : 'text-green-500')}
                />
              ),
              label: <span className="text-sm">{origin ? siteLabel(origin) : 'Sign in'}</span>,
              statusLabel: state.status === 'browser_closed' ? browserClosedLabel(state.saved) : STATUS_LABELS[state.status],
              isSuccess: state.status === 'browser_closed' ? state.saved !== null : state.status !== 'declined',
            }
          : null
      }
      readOnly={readOnly ? {} : false}
      data-testid={done ? 'login-request-completed' : 'login-request'}
      data-status={done ? state.status : undefined}
    >
      {!readOnly && (
        <LoginForm
          agentSlug={agentSlug}
          sessionId={sessionId}
          toolUseId={toolUseId}
          fields={fields}
          vault={vault}
          autoFocus
        />
      )}
    </RequestItemShell>
  )
}
