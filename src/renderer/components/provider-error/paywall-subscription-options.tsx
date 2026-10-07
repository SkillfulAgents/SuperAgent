import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
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

export function PaywallSubscriptionOptions({ session, onResumed }: { session: Session; onResumed: () => void }) {
  const { canUseAgent } = useUser()
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  if (!canUseAgent(session.agentSlug)) return null

  return (
    <div className="relative mt-3 rounded-xl border border-border/70 bg-background/90 px-4 py-4 backdrop-blur-md sm:px-6" data-testid="paywall-subscriptions">
      <p className="text-sm font-medium">OR Connect to an existing subscription</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Already subscribed? Connect your account to continue this chat.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUBSCRIPTIONS.map(option => (
          <Button key={option.provider} type="button" variant="outline" size="sm" onClick={() => setSubscription(option)}>
            <ProviderLogo provider={option.provider} className="h-4 w-4" />
            {`Connect ${option.name}`}
          </Button>
        ))}
      </div>
      {subscription && (
        <SubscriptionDialog
          subscription={subscription}
          session={session}
          onClose={() => setSubscription(null)}
          onResumed={onResumed}
        />
      )}
    </div>
  )
}

function SubscriptionDialog({ subscription, session, onClose, onResumed }: {
  subscription: Subscription
  session: Session
  onClose: () => void
  onResumed: () => void
}) {
  const { user, isAuthMode } = useUser()
  const { data: settings } = useModelSettings()
  const { refetch } = useLlmConnections()
  const { isActive } = useMessageStream(session.sessionId, session.agentSlug)
  const { mutateAsync: sendMessage } = useSendMessage({ quiet: true })
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const active = useRef(isActive)
  active.current = isActive
  const attempted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const resume = useCallback(async (id: string) => {
    if (inFlight.current || active.current || !mounted.current) return
    setError('')
    inFlight.current = true
    setResuming(true)
    try {
      const result = await refetch({ throwOnError: true })
      if (!mounted.current || active.current) return
      const connection = result.data?.connections.find(item => item.id === id)
      const model = connection?.defaultModel ?? connection?.catalog[0]?.id
      const selection = model && connection?.isConfigured
        ? resolveSelection({ llmProviderId: id, model }, [connection])
        : null
      if (!selection) throw new Error('Your connection was saved, but no model is available yet. Try again.')
      const sent = await sendMessage({
        ...session,
        content: 'Continue',
        llmProviderId: selection.llmProviderId,
        model: selection.model,
      })
      // A turn started elsewhere while we were connecting. Queued messages do not
      // apply provider changes, so don't dismiss the paywall as if the switch succeeded.
      if (sent.queued) throw new Error('The chat is still busy. Resume when its current turn finishes.')
      if (mounted.current) onResumed()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not resume this chat. Try again.')
    } finally {
      inFlight.current = false
      if (mounted.current) setResuming(false)
    }
  }, [refetch, sendMessage, session, onResumed])

  useEffect(() => {
    // A provider error may arrive just before the previous turn becomes idle.
    // Wait for that turn, then continue once; failures have an explicit retry.
    if (!connectionId || isActive || attempted.current) return
    attempted.current = true
    void resume(connectionId)
  }, [connectionId, isActive, resume])

  return (
    <Dialog open onOpenChange={open => { if (!open && !inFlight.current) onClose() }}>
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
            onClose={onClose}
            onSaved={setConnectionId}
            saveLabel="Save and resume chat"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
