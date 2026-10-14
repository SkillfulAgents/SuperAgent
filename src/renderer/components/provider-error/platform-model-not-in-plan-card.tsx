import { useEffect, useMemo, useState } from 'react'
import { Loader2, Lock } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { usePlanUpgrade } from '@renderer/context/plan-upgrade-context'
import { useUser } from '@renderer/context/user-context'
import { useLlmConnections } from '@renderer/hooks/use-llm-connections'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSendMessage } from '@renderer/hooks/use-messages'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { usePlatformPlan } from '@renderer/hooks/use-platform-plan'
import { useProviderModelAvailability } from '@renderer/hooks/use-provider-model-availability'
import { useSession } from '@renderer/hooks/use-sessions'
import { PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'
import { bestAllowedModel } from '@shared/lib/llm-provider/model-availability'
import { canonicalModelId, parseModelNotInPlan, planModelLabel } from '@shared/lib/llm-provider/plan-model-policy'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { cn } from '@shared/lib/utils'

import { isPlatformOrgAdmin } from './platform-paywall-cta'
import type { ProviderErrorComponentProps } from './provider-error-registry'

type Session = NonNullable<ProviderErrorComponentProps['session']>

/**
 * The proxy refused a model the workspace's plan excludes (403
 * model_not_in_plan): a stale client, a saved agent or automation, or a
 * downgrade that took effect mid-session. Not a failure to retry, so no
 * generic error copy: name the model, re-read the plan, and offer the two ways
 * forward — upgrade, or continue this chat on the best model the plan allows.
 */
export function PlatformModelNotInPlanCard({ message, live = true, dismissible = false, session }: ProviderErrorComponentProps) {
  const [dismissed, setDismissed] = useState(false)
  const model = useMemo(() => parseModelNotInPlan(message)?.model ?? null, [message])
  const { plan, excludedLabel, refresh } = usePlatformPlan()
  const { data: sessionData } = useSession(session?.sessionId ?? null, session?.agentSlug ?? null)
  const { data: connectionData } = useLlmConnections(session?.agentSlug, session?.sessionId, sessionData?.llmProviderId)
  const connections = connectionData?.connections ?? []
  const connection = connections.find(c => c.id === sessionData?.llmProviderId && c.provider === 'platform')
    ?? connections.find(c => c.provider === 'platform' && c.isConfigured)
  const { isUnavailable, updatedAt } = useProviderModelAvailability(connection)
  const { data: platformAuth } = usePlatformAuthStatus()
  const openUpgrade = usePlanUpgrade()
  const [seenAt] = useState(() => Date.now())
  const role = platformAuth?.role
  const canManage = role == null || isPlatformOrgAdmin(role)
  const label = model ? planModelLabel(model, PLATFORM_CATALOG) : 'This model'

  // The refusal means the plan changed under this client: re-read it now.
  useEffect(() => {
    if (live) void refresh()
  }, [live, refresh])

  // Billing may reflect an upgrade before the proxy's cached model policy does.
  // Keep both a retry and a previously allowed alternative after a fresh snapshot.
  const refused = model && connection?.catalog.find(m => canonicalModelId(m.id) === canonicalModelId(model))
  const allowedNow = !!refused && updatedAt > seenAt && !isUnavailable(refused)

  if (dismissed) return null
  return (
    <div className="relative px-4 pb-2" data-testid="model-not-in-plan-card-frame">
      <div
        data-testid="model-not-in-plan-card"
        data-allowed={allowedNow}
        className="relative flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border/70 bg-background/90 px-5 py-4 backdrop-blur-md"
      >
        <div className="flex min-w-0 flex-1 basis-60 items-start gap-2.5">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {allowedNow ? `${label} is included in your plan now` : `${label} isn't included in your plan`}
            </p>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {allowedNow
                ? 'Model access may take a minute to update. Retry this model or continue with another.'
                : `${plan && excludedLabel ? `${plan.name} excludes ${excludedLabel}. ` : ''}${canManage ? 'Upgrade to use it, or continue with a model your plan includes.' : 'Ask a workspace owner or admin to upgrade, or continue with a model your plan includes.'}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dismissible && (
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>Dismiss</Button>
          )}
          {session && (
            <ContinueButton
              session={session}
              connection={connection}
              deniedModel={model}
              sameModel={allowedNow}
              isUnavailable={isUnavailable}
              onContinued={() => setDismissed(true)}
            />
          )}
          {!allowedNow && canManage && (
            <Button size="sm" onClick={() => openUpgrade(model ? { model, connectionId: connection?.id } : {})} data-testid="model-not-in-plan-upgrade">
              Upgrade plan
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Sends "Continue" on the chat's platform connection. After an upgrade, a
 * recent proxy refusal still matters: let the user retry that model or use a
 * different family while the proxy's policy cache catches up.
 */
function ContinueButton({ session, connection, deniedModel, sameModel, isUnavailable, onContinued }: {
  session: Session
  connection: ConnectionInfo | undefined
  deniedModel: string | null
  sameModel: boolean
  isUnavailable: (model: ModelDefinition) => boolean
  onContinued: () => void
}) {
  const { canUseAgent } = useUser()
  const { isActive } = useMessageStream(session.sessionId, session.agentSlug)
  const { mutateAsync: sendMessage, isPending } = useSendMessage({ quiet: true })
  const [error, setError] = useState('')

  const denied: ModelDefinition | undefined = deniedModel && connection
    ? connection.catalog.find((m) => canonicalModelId(m.id) === canonicalModelId(deniedModel))
    : undefined
  const retryModel = sameModel ? denied : undefined
  const fallback = connection && bestAllowedModel(
    connection.catalog,
    (m) => isUnavailable(m) ||
      (!!denied?.family && m.family === denied.family) ||
      (deniedModel !== null && canonicalModelId(m.id) === canonicalModelId(deniedModel)),
    denied,
  )

  if (!connection || (!retryModel && !fallback) || !canUseAgent(session.agentSlug)) return null
  const continueChat = async (target: ModelDefinition) => {
    setError('')
    try {
      const sent = await sendMessage({
        ...session,
        content: 'Continue',
        llmProviderId: connection.id,
        model: target.id,
      })
      // A queued message doesn't switch the model, so the chat would hit the same refusal.
      if (sent.queued) {
        setError('The chat is still busy. Continue when its current turn finishes.')
        return
      }
      onContinued()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not continue this chat. Try again.')
    }
  }
  return (
    <>
      {error && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
      {retryModel && (
        <Button
          size="sm"
          className={cn(isPending && 'gap-1.5')}
          disabled={isPending || isActive}
          onClick={() => void continueChat(retryModel)}
          data-testid="model-not-in-plan-retry"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Retry with {retryModel.label}
        </Button>
      )}
      {fallback && (
        <Button
          size="sm"
          variant="outline"
          className={cn(isPending && 'gap-1.5')}
          disabled={isPending || isActive}
          onClick={() => void continueChat(fallback)}
          data-testid="model-not-in-plan-continue"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Continue with {fallback.label}
        </Button>
      )}
    </>
  )
}
