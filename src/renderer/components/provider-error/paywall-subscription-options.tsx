import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { ConnectionEditor } from '@renderer/components/settings/llm-connections-tab'
import { ProviderLogo } from '@renderer/components/settings/provider-logo'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { useUser } from '@renderer/context/user-context'
import { useConnectionMutation, useLlmConnections } from '@renderer/hooks/use-llm-connections'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useCancelQueuedMessage, useSendMessage } from '@renderer/hooks/use-messages'
import { useProviderUsages, supportsUsage } from '@renderer/hooks/use-provider-usage'
import { useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { resolveSelection, type ConnectionInfo, type ModelSelection } from '@shared/lib/llm-provider/connection-schema'
import { isProviderUsageExhausted } from '@shared/lib/llm-provider/usage-schema'
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
type SwitchScope = 'session' | 'always'
type GlobalSelectionState = { defaultSelection: ModelSelection | null; summarizerSelection: ModelSelection | null }
type ResolvedConnectionSelection = ModelSelection & { wireModel: string }
type SavedSubscriptionOption = {
  connection: ConnectionInfo
  subscription: Subscription
  selection: ResolvedConnectionSelection
}

function selectionForConnection(connection: ConnectionInfo): ResolvedConnectionSelection | null {
  const model = connection.defaultModel ?? connection.catalog[0]?.id
  if (!model || !connection.isConfigured) return null
  return resolveSelection({ llmProviderId: connection.id, model }, [connection])
}

// One literal per funnel step so every name is greppable and in the catalog.
const SUBSCRIPTION_FUNNEL_EVENTS = {
  sign_in_started: 'paywall_subscription_sign_in_started',
  sign_in_opened: 'paywall_subscription_sign_in_opened',
  sign_in_succeeded: 'paywall_subscription_sign_in_succeeded',
  sign_in_failed: 'paywall_subscription_sign_in_failed',
  token_entered: 'paywall_subscription_token_entered',
  save_started: 'paywall_subscription_save_started',
  saved: 'paywall_subscription_saved',
  save_failed: 'paywall_subscription_save_failed',
  resume_started: 'paywall_subscription_resume_started',
  resume_failed: 'paywall_subscription_resume_failed',
  resumed: 'paywall_subscription_resumed',
  cancelled: 'paywall_subscription_cancelled',
} as const
type SubscriptionFunnelStep = keyof typeof SUBSCRIPTION_FUNNEL_EVENTS

export function PaywallSubscriptionOptions({ session, onResumed, analytics }: {
  session: Session
  onResumed: (recovery: SubscriptionRecovery) => void
  analytics: PaywallAnalyticsContext
}) {
  const { canUseAgent } = useUser()
  const track = usePaywallTracking()
  const { data: connectionData } = useLlmConnections()
  const [attempt, setAttempt] = useState<SubscriptionAttempt | null>(null)
  const shown = useRef(false)
  const eligible = canUseAgent(session.agentSlug)
  const candidates = (connectionData?.connections ?? []).flatMap(connection => {
    const subscription = SUBSCRIPTIONS.find(option => option.provider === connection.provider)
    return subscription ? [{ connection, subscription }] : []
  })
  const usage = useProviderUsages(candidates.map(option => option.connection))
  const activeConnections = candidates.flatMap(({ connection, subscription }, index): SavedSubscriptionOption[] => {
    const selection = selectionForConnection(connection)
    if (!selection) return []
    if (supportsUsage(connection)) {
      const snapshot = usage[index]
      if (!snapshot || snapshot.isPending || snapshot.isError || !snapshot.data || snapshot.data.status === 'unavailable') return []
      if (snapshot.data.status === 'available' && isProviderUsageExhausted(snapshot.data, connection.provider, selection.wireModel)) return []
    }
    return [{ connection, subscription, selection }]
  })
  useEffect(() => {
    if (!eligible || shown.current) return
    shown.current = true
    track('paywall_subscription_options_shown', { ...analytics })
  }, [eligible, analytics, track])
  if (!eligible) return null

  return (
    <div className="relative mt-3 rounded-xl border border-border/70 bg-background/90 px-4 py-4 backdrop-blur-md sm:px-6" data-testid="paywall-subscriptions">
      {activeConnections.length > 0 && (
        <SavedSubscriptionConnections options={activeConnections} previousDefault={connectionData?.defaultSelection ?? null}
          previousSummarizer={connectionData?.summarizerSelection ?? null}
          session={session} analytics={analytics} onResumed={onResumed} />
      )}
      <div className={activeConnections.length > 0 ? 'mt-4 border-t border-border/70 pt-4' : undefined}>
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

function SavedSubscriptionConnections({ options, previousDefault, previousSummarizer, session, analytics, onResumed }: {
  options: SavedSubscriptionOption[]
  previousDefault: ModelSelection | null
  previousSummarizer: ModelSelection | null
  session: Session
  analytics: PaywallAnalyticsContext
  onResumed: (recovery: SubscriptionRecovery) => void
}) {
  const { isAdmin, isAuthMode } = useUser()
  const track = usePaywallTracking()
  const { isActive } = useMessageStream(session.sessionId, session.agentSlug, ['isActive'])
  const { mutateAsync: sendMessage } = useSendMessage({ quiet: true })
  const { mutateAsync: cancelQueuedMessage } = useCancelQueuedMessage()
  const { mutateAsync: setGlobalDefault } = useConnectionMutation()
  const { mutateAsync: setAgentDefault } = useUpdateAgentPreferences(session.agentSlug)
  const [pending, setPending] = useState<{ connectionId: string; scope: SwitchScope } | null>(null)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const active = useRef(isActive)
  const mounted = useRef(true)
  active.current = isActive
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const switchTo = useCallback(async (option: SavedSubscriptionOption, scope: SwitchScope) => {
    if (inFlight.current || active.current) return
    const canAlwaysUse = !isAuthMode || (isAdmin && option.connection.userId === null)
    if (scope === 'always' && !canAlwaysUse) return
    inFlight.current = true
    setError('')
    setPending({ connectionId: option.connection.id, scope })
    const attemptId = uuid()
    let globalDefaultWritten: GlobalSelectionState | null = null
    let agentDefaultChanged = false
    try {
      if (scope === 'always') {
        const written = await setGlobalDefault({
          path: '/defaults/default', method: 'PUT',
          body: { llmProviderId: option.selection.llmProviderId, model: option.selection.model },
        }) as GlobalSelectionState
        globalDefaultWritten = { defaultSelection: written.defaultSelection, summarizerSelection: written.summarizerSelection }
        if (!mounted.current || active.current) throw new Error('The chat is still busy. Try again when its current turn finishes.')
        await setAgentDefault({
          defaultLlmProviderId: option.selection.llmProviderId,
          defaultModel: option.selection.model,
        })
        agentDefaultChanged = true
      }
      if (!mounted.current) return
      if (active.current) throw new Error('The chat is still busy. Try again when its current turn finishes.')
      const sent = await sendMessage({
        ...session,
        content: 'Continue',
        llmProviderId: option.selection.llmProviderId,
        model: option.selection.model,
      })
      if (sent.queued) {
        const cancelled = await cancelQueuedMessage({ ...session, uuid: sent.uuid })
        throw new Error(cancelled.cancelled
          ? 'The chat is still busy. Try again when its current turn finishes.'
          : 'The chat became busy and already started this continuation on its current provider.')
      }
      track('paywall_subscription_switched', {
        ...analytics,
        attemptId,
        provider: option.subscription.provider,
        scope,
      })
      onResumed({ attemptId, provider: option.subscription.provider, scope })
    } catch (cause) {
      let failure = cause
      if (globalDefaultWritten && !agentDefaultChanged && !previousDefault) {
        failure = new Error('The app default was set, but this agent\'s default could not be saved. Check Model Providers settings.')
      } else if (globalDefaultWritten && !agentDefaultChanged && previousDefault) {
        try {
          const restored = await setGlobalDefault({
            path: '/defaults/default/compare-and-set', method: 'PUT',
            body: {
              expected: globalDefaultWritten,
              restore: { defaultSelection: previousDefault, summarizerSelection: previousSummarizer },
            },
          }) as { updated: boolean }
          if (!restored.updated) failure = new Error('The app default was changed elsewhere, so it was left as is. Check Model Providers settings.')
        } catch {
          failure = new Error('Could not restore your previous app default. Check Model Providers settings before retrying.')
        }
      }
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not switch subscriptions. Try again.')
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(null)
    }
  }, [analytics, cancelQueuedMessage, isAdmin, isAuthMode, onResumed, previousDefault, previousSummarizer, sendMessage, session, setAgentDefault, setGlobalDefault, track])

  return (
    <div data-testid="active-subscription-connections">
      <p className="text-sm font-medium">Use an active subscription</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Switch this chat now, or make the connection your default.</p>
      <div className="mt-3 space-y-2">
        {options.map(option => {
          const canAlwaysUse = !isAuthMode || (isAdmin && option.connection.userId === null)
          const switching = pending?.connectionId === option.connection.id
          return (
            <div key={option.connection.id} data-testid="active-subscription-connection"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 px-3 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <ProviderLogo provider={option.subscription.provider} className="h-5 w-5" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{option.subscription.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{option.connection.name}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={isActive || pending !== null}
                  onClick={() => void switchTo(option, 'session')}>
                  {switching && pending?.scope === 'session' ? 'Switching…' : 'Switch for this session'}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={isActive || pending !== null || !canAlwaysUse}
                  title={canAlwaysUse ? undefined : 'App-wide defaults require a global connection and workspace admin access.'}
                  onClick={() => void switchTo(option, 'always')}>
                  {switching && pending?.scope === 'always' ? 'Switching…' : `Always use ${option.subscription.name}`}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
      {isActive && <p role="status" className="mt-2 text-xs text-muted-foreground">Waiting for the current turn to finish…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
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
  const { isActive } = useMessageStream(session.sessionId, session.agentSlug, ['isActive'])
  const { mutateAsync: sendMessage } = useSendMessage({ quiet: true })
  const { mutateAsync: cancelQueuedMessage } = useCancelQueuedMessage()
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
  const report = useCallback((step: SubscriptionFunnelStep, properties: Record<string, unknown> = {}) => {
    lastStep.current = step
    track(SUBSCRIPTION_FUNNEL_EVENTS[step], {
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
      const selection = connection ? selectionForConnection(connection) : null
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
        const cancelled = await cancelQueuedMessage({ ...session, uuid: sent.uuid })
        throw new Error(cancelled.cancelled
          ? 'The chat is still busy. Resume when its current turn finishes.'
          : 'The chat became busy and already started this continuation on its current provider.')
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
  }, [cancelQueuedMessage, refetch, sendMessage, session, onResumed, report, attempt.attemptId, subscription.provider])

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
