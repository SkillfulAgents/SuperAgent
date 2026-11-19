import { useState } from 'react'
import { Smartphone } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from '../requests/decline-button'
import { siteLabel, type LoginContext } from './login-request'
import { LoginSiteHeading, SignInOnPage } from './login-form'
import { AddSignInMethodBox } from './login-vault-sections'
import { useLoginRequestActions, useLoginVaultInfo } from './use-login-request'

interface LoginWaysProps {
  agentSlug: string
  sessionId: string
  toolUseId: string
  /** The page as the browser located it: its ways, in the page's words. */
  context: LoginContext
}

/**
 * A page that asks how to verify it's you: the user picks one of its ways,
 * and the host clicks it on the page. The page's only way with nothing to
 * click (a prompt on their phone) is theirs to answer there: the card goes
 * once the page moves on, or when they say they did. For an account of
 * theirs, the card offers to have the agent add an authenticator app, so the
 * next sign-in needs none of this.
 */
export function LoginWays({ agentSlug, sessionId, toolUseId, context }: LoginWaysProps) {
  const { state, chooseWay, requestMethod, completeManually, decline } = useLoginRequestActions({ agentSlug, sessionId, toolUseId })
  const vaultInfo = useLoginVaultInfo(agentSlug, sessionId, toolUseId, true)
  const [mode, setMode] = useState<'ways' | 'manual'>('ways')
  const [picking, setPicking] = useState<number | null>(null)
  const busy = state.status === 'submitting'
  const running = state.status === 'submitting' ? state.action : null
  const error = state.status === 'idle' ? state.error : undefined
  const site = siteLabel(context.origin)
  const prompt = context.ways.length === 1 && !context.ways[0].clickable ? context.ways[0] : null
  const addMethod = vaultInfo.data?.addMethod ?? null
  const pick = (index: number) => {
    setPicking(index)
    void chooseWay(context, index)
  }

  if (mode === 'manual') {
    return (
      <div className="space-y-3 pt-4" data-testid="login-manual">
        <SignInOnPage
          origin={context.origin}
          error={error}
          busy={busy}
          finishing={running === 'manual'}
          back="Back to the ways"
          onBack={() => setMode('ways')}
          onDone={() => void completeManually()}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 pt-4" data-testid="login-ways-step">
      <LoginSiteHeading context={context} />
      {prompt ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground" data-testid="login-way-prompt">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block break-words">{prompt.label}</span>
            <span className="block text-2xs text-muted-foreground">This closes by itself once {site} moves on.</span>
          </span>
        </div>
      ) : (
        <div className="space-y-1.5" role="group" aria-label={`How ${site} can verify it's you`} data-testid="login-ways">
          <p className="text-xs text-muted-foreground">{site} asks how to verify it&apos;s you. The way you pick is clicked on the page for you.</p>
          {context.ways.map((way, index) => (
            <Button
              key={index}
              variant="outline"
              size="sm"
              className="h-auto w-full justify-start whitespace-normal py-2 text-left"
              onClick={() => pick(index)}
              loading={running === 'way' && picking === index}
              disabled={busy}
              data-testid={`login-way-${index}`}
            >
              {way.label}
            </Button>
          ))}
        </div>
      )}
      {addMethod && <AddSignInMethodBox addMethod={addMethod} onRequest={requestMethod} disabled={busy} />}
      {error && <p className="text-xs text-destructive" role="alert" data-testid="login-error">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-0 text-xs text-muted-foreground"
          onClick={() => setMode('manual')}
          disabled={busy}
          data-testid="login-take-over"
        >
          Do it on the page instead
        </Button>
        <div className="flex items-center gap-2">
          <DeclineButton
            onDecline={(reason) => void decline(reason)}
            disabled={busy}
            label="Decline"
            showIcon={false}
            size="xs"
            className="border-border text-foreground hover:bg-muted"
            data-testid="login-decline"
          />
          {prompt && (
            <Button
              size="xs"
              className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => pick(0)}
              loading={running === 'way'}
              disabled={busy}
              data-testid="login-way-done"
            >
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
