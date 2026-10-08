import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { ConnectionEditor } from '@renderer/components/settings/llm-connections-tab'
import { ProviderLogo } from '@renderer/components/settings/provider-logo'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { useUser } from '@renderer/context/user-context'
import { useLlmConnections } from '@renderer/hooks/use-llm-connections'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSendMessage } from '@renderer/hooks/use-messages'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { resolveSelection } from '@shared/lib/llm-provider/connection-schema'
import type { ConnectionSetupObserver } from '@renderer/components/settings/connection-setup-events'
import { usePaywallTracking, type PaywallAnalyticsContext, type SubscriptionRecovery } from './paywall-analytics'
import type { ProviderErrorComponentProps } from './provider-error-registry'

const SUBSCRIPTIONS = [
  { provider: 'grok-subscription', name: 'Grok' },
  { provider: 'codex-subscription', name: 'OpenAI' },
  { provider: 'kimi-subscription', name: 'Kimi' },
  { provider: 'minimax-subscription', name: 'MiniMax' },
  { provider: 'claude-subscription', name: 'Claude Code' },
] as const
type Subscription = typeof SUBSCRIPTIONS[number]
type Session = NonNullable<ProviderErrorComponentProps['session']>
type SubscriptionAttempt = {
  subscription: Subscription
  attemptId: string
  startedAt: number
  analytics: PaywallAnalyticsContext
}

export function PaywallSubscriptionOptions({ session, onResumed, analytics }: {
  session: Session
  onResumed: (recovery: SubscriptionRecovery) => void
  analytics: PaywallAnalyticsContext
}) {
  const { canUseAgent } = useUser()
  const track = usePaywallTracking()
  const [attempt, setAttempt] = useState<SubscriptionAttempt | null>(null)
  const shown = useRef(false)
  const eligible = canUseAgent(session.agentSlug)
  useEffect(() => {
    if (!eligible || shown.current) return
    shown.current = true
    track('paywall_subscription_options_shown', { ...analytics })
  }, [eligible, analytics, track])
  if (!eligible) return null

  return (
    <div className="relative mt-3 rounded-xl border border-border/70 bg-background/90 px-4 py-4 backdrop-blur-md sm:px-6" data-testid="paywall-subscriptions">
      <p className="text-sm font-medium">OR Connect to an existing subscription</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Already subscribed? Connect your account to continue this chat.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUBSCRIPTIONS.map(option => (
          <Button key={option.provider} type="button" variant="outline" size="sm" onClick={() => {
            const next = { subscription: option, attemptId: uuid(), startedAt: performance.now(), analytics }
            track('paywall_subscription_clicked', {
              ...analytics, attemptId: next.attemptId, provider: option.provider,
              authMethod: option.provider === 'claude-subscription' ? 'setup_token' : 'device_code',
              elapsedMs: 0,
            })
            setAttempt(next)
          }}>
            <ProviderLogo provider={option.provider} className="h-4 w-4" />
            {`Connect ${option.name}`}
          </Button>
        ))}
      </div>
      {attempt && (
        <SubscriptionDialog
          key={attempt.attemptId}
          attempt={attempt}
          session={session}
          onClose={() => setAttempt(null)}
          onResumed={onResumed}
        />
      )}
    </div>
  )
}

function SubscriptionDialog({ attempt, session, onClose, onResumed }: {
  attempt: SubscriptionAttempt
  session: Session
  onClose: () => void
  onResumed: (recovery: SubscriptionRecovery) => void
}) {
  const { subscription } = attempt
  const track = usePaywallTracking()
  const { user, isAuthMode } = useUser()
  const { data: settings } = useModelSettings()
  const { refetch } = useLlmConnections()
  const { isActive } = useMessageStream(session.sessionId, session.agentSlug)
  const { mutateAsync: sendMessage } = useSendMessage({ quiet: true })
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const resumeRequestPending = useRef(false)
  const mounted = useRef(true)
  const active = useRef(isActive)
  active.current = isActive
  const attempted = useRef(false)
  const resumeAttempt = useRef(0)
  const finished = useRef(false)
  const connectionSaved = useRef(false)
  const lastStep = useRef('clicked')
  const report = useCallback((step: string, properties: Record<string, unknown> = {}) => {
    lastStep.current = step
    track(`paywall_subscription_${step}`, {
      ...attempt.analytics,
      attemptId: attempt.attemptId,
      provider: subscription.provider,
      authMethod: subscription.provider === 'claude-subscription' ? 'setup_token' : 'device_code',
      elapsedMs: Math.round(performance.now() - attempt.startedAt),
      ...properties,
    })
  }, [track, attempt, subscription.provider])
  const observeSetup = useCallback<ConnectionSetupObserver>(({ step, ...properties }) => {
    if (step === 'saved') connectionSaved.current = true
    report(step, properties)
  }, [report])
  const cancel = useCallback((reason: 'dismissed' | 'unmounted') => {
    if (finished.current) return
    finished.current = true
    report('cancelled', { reason, lastStep: lastStep.current, connectionSaved: connectionSaved.current })
  }, [report])
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Strict Mode replays effects without a real dismissal. Wait until its
      // synchronous setup has had a chance to restore the mounted flag.
      queueMicrotask(() => {
        // stream_start can hide the wall before the send response arrives.
        // Let that response settle the attempt instead of reporting a cancel.
        if (!mounted.current && !resumeRequestPending.current) cancelRef.current('unmounted')
      })
    }
  }, [])
  const close = () => {
    if (inFlight.current) return
    cancel('dismissed')
    onClose()
  }

  const resume = useCallback(async (id: string) => {
    if (inFlight.current || active.current || !mounted.current) return
    setError('')
    inFlight.current = true
    setResuming(true)
    resumeAttempt.current += 1
    report('resume_started', { resumeAttempt: resumeAttempt.current })
    let failureReason = 'connection_refresh_failed'
    try {
      const result = await refetch({ throwOnError: true })
      if (!mounted.current) return
      if (active.current) {
        failureReason = 'chat_busy'
        throw new Error('The chat is still busy. Resume when its current turn finishes.')
      }
      const connection = result.data?.connections.find(item => item.id === id)
      const model = connection?.defaultModel ?? connection?.catalog[0]?.id
      const selection = model && connection?.isConfigured
        ? resolveSelection({ llmProviderId: id, model }, [connection])
        : null
      if (!selection) {
        failureReason = 'model_unavailable'
        throw new Error('Your connection was saved, but no model is available yet. Try again.')
      }
      failureReason = 'send_failed'
      resumeRequestPending.current = true
      const sent = await sendMessage({
        ...session,
        content: 'Continue',
        llmProviderId: selection.llmProviderId,
        model: selection.model,
      })
      // A turn started elsewhere while we were connecting. Queued messages do not
      // apply provider changes, so don't dismiss the paywall as if the switch succeeded.
      if (sent.queued) {
        failureReason = 'chat_busy'
        throw new Error('The chat is still busy. Resume when its current turn finishes.')
      }
      finished.current = true
      report('resumed', { resumeAttempt: resumeAttempt.current, outcome: 'message_accepted' })
      onResumed({ attemptId: attempt.attemptId, provider: subscription.provider })
    } catch (cause) {
      report('resume_failed', { resumeAttempt: resumeAttempt.current, failureReason })
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not resume this chat. Try again.')
    } finally {
      resumeRequestPending.current = false
      if (!mounted.current) cancelRef.current('unmounted')
      inFlight.current = false
      if (mounted.current) setResuming(false)
    }
  }, [refetch, sendMessage, session, onResumed, report, attempt.attemptId, subscription.provider])

  useEffect(() => {
    // A provider error may arrive just before the previous turn becomes idle.
    // Wait for that turn, then continue once; failures have an explicit retry.
    if (!connectionId || isActive || attempted.current) return
    attempted.current = true
    void resume(connectionId)
  }, [connectionId, isActive, resume])

  return (
    <Dialog open onOpenChange={open => { if (!open) close() }}>
      <DialogContent className="gap-8 p-6 sm:max-w-2xl sm:p-10" aria-describedby={undefined} hideClose={resuming}>
        {connectionId ? (
          <>
            <DialogHeader>
              <DialogTitle>{subscription.name} connected</DialogTitle>
              <DialogDescription>Your subscription is saved. This chat will use it when you resume.</DialogDescription>
            </DialogHeader>
            {resuming ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Resuming your chat…
              </p>
            ) : (
              <>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {isActive && <p role="status" className="text-sm text-muted-foreground">Waiting for the current turn to finish…</p>}
                <Button disabled={isActive} onClick={() => void resume(connectionId)}>Resume chat</Button>
              </>
            )}
          </>
        ) : (
          <ConnectionEditor
            initialProvider={subscription.provider}
            userId={isAuthMode ? user?.id ?? null : null}
            admin={false}
            modelPricing={settings?.modelPricing ?? {}}
            catalogFor={provider => settings?.llmProviderStatus.find(item => item.id === provider)?.builtinCatalog ?? []}
            onClose={close}
            onSaved={setConnectionId}
            saveLabel="Save and resume chat"
            onSetupEvent={observeSetup}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
