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
import { useSession } from '@renderer/hooks/use-sessions'
import { PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'
import { bestAllowedModel, canonicalModelId, parseModelNotInPlan, planModelLabel } from '@shared/lib/llm-provider/plan-model-policy'
import type { ModelDefinition } from '@shared/lib/llm-provider'
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
  const { plan, excludedLabel, isDenied, updatedAt, refresh } = usePlatformPlan()
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

  // A snapshot newer than this card that allows the model: an upgrade went through.
  const allowedNow = !!model && updatedAt > seenAt && !isDenied(model)

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
                ? 'Continue to pick this chat back up.'
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
              deniedModel={model}
              sameModel={allowedNow}
              isDenied={isDenied}
              onContinued={() => setDismissed(true)}
            />
          )}
          {!allowedNow && canManage && (
            <Button size="sm" onClick={() => openUpgrade(model ? { model } : {})} data-testid="model-not-in-plan-upgrade">
              Upgrade plan
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Sends "Continue" on the chat's platform connection: on the refused model once
 * the plan allows it, otherwise on the best model the plan does allow.
 */
function ContinueButton({ session, deniedModel, sameModel, isDenied, onContinued }: {
  session: Session
  deniedModel: string | null
  sameModel: boolean
  isDenied: (model: string) => boolean
  onContinued: () => void
}) {
  const { canUseAgent } = useUser()
  const { data: sessionData } = useSession(session.sessionId, session.agentSlug)
  const { data: connectionData } = useLlmConnections(session.agentSlug, session.sessionId, sessionData?.llmProviderId)
  const { isActive } = useMessageStream(session.sessionId, session.agentSlug)
  const { mutateAsync: sendMessage, isPending } = useSendMessage({ quiet: true })
  const [error, setError] = useState('')

  const connections = connectionData?.connections ?? []
  const connection = connections.find((c) => c.id === sessionData?.llmProviderId && c.provider === 'platform')
    ?? connections.find((c) => c.provider === 'platform' && c.isConfigured)
  const denied: ModelDefinition | undefined = deniedModel && connection
    ? connection.catalog.find((m) => canonicalModelId(m.id) === canonicalModelId(deniedModel))
    : undefined
  const target = !connection
    ? undefined
    : sameModel && denied
      ? denied
      : bestAllowedModel(connection.catalog, (m) => isDenied(m.id), denied)

  if (!connection || !target || !canUseAgent(session.agentSlug)) return null
  const continueChat = async () => {
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
      <Button
        size="sm"
        variant={sameModel ? 'default' : 'outline'}
        className={cn(isPending && 'gap-1.5')}
        disabled={isPending || isActive}
        onClick={() => void continueChat()}
        data-testid="model-not-in-plan-continue"
      >
        {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {sameModel ? 'Continue' : `Continue with ${target.label}`}
      </Button>
    </>
  )
}
