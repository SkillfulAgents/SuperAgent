import { AgentAvatar, AgentOrbSilhouette, type AvatarMotionState } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ApiAgent } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils'

/** Which of the agent orb's states a call is in, as on the iOS call screen. */
export function callOrbState({ ready, waitingForInput = false, busy }: { ready: boolean; waitingForInput?: boolean; busy: boolean }): AvatarMotionState {
  if (!ready) return 'sleeping'
  if (waitingForInput) return 'needs-input'
  return busy ? 'working' : 'idle'
}

/**
 * The agent's own orb in a voice call, as the iOS call screen draws it:
 * asleep while the connection comes up, idle while it listens, and broken
 * into its working dots while it thinks and speaks, with its outer shape
 * left behind them as a ghost so the agent is still there.
 */
export function AgentCallOrb({ agent, state, size, className }: {
  agent: Pick<ApiAgent, 'slug' | 'avatar'>
  state: AvatarMotionState
  size: number
  className?: string
}) {
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }} data-testid="agent-call-orb" data-orb-state={state}>
      <AgentOrbSilhouette
        agent={agent}
        size={size}
        className={cn('absolute inset-0 transition-opacity duration-300', state === 'working' ? 'opacity-[0.08] dark:opacity-[0.14]' : 'opacity-0')}
      />
      <AgentAvatar agent={agent} state={state} size={size} />
    </div>
  )
}
