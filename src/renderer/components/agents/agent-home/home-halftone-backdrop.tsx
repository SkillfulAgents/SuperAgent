import type { ApiAgent } from '@renderer/hooks/use-agents'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { Halftone } from '@renderer/components/agents/halftone'
import { AGENT_HALFTONE_GRID, HALFTONE_STATE, avatarHalftoneInk, hashSlug } from '@renderer/components/agents/agent-halftone'
import { useIsDark } from '@renderer/hooks/use-theme'
import { cn } from '@shared/lib/utils/cn'

/**
 * Agent Home's and its sessions' background: the agent's own card halftone (the all-agents home page), filling the view:
 * the same grid, motif and per-agent phase, in its idle state only, inked in the avatar's colour as the card is
 * (evened out across colours and themes: avatarHalftoneInk).
 * Unlike the card it doesn't answer the pointer. Without an avatar, the card's grey.
 */
/** The ink's strength for a typical colour: stronger than the idle card's 70%, across a whole view rather than a card. */
const INK_STRENGTH = 0.85

export function HomeHalftoneBackdrop({ agent }: { agent: Pick<ApiAgent, 'slug' | 'avatar'> }) {
  const dark = useIsDark()
  const ink = agent.avatar ? avatarHalftoneInk(avatarSource(agent.avatar).orb, dark, INK_STRENGTH) : undefined
  const idle = HALFTONE_STATE.idle
  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', !ink && 'text-muted-foreground/50')}
      // One name on Agent Home's and the session's, so it holds still through the transition between them.
      style={ink ? { color: ink.color, opacity: ink.opacity, viewTransitionName: 'agent-backdrop' } : { viewTransitionName: 'agent-backdrop' }}
      data-testid="agent-home-halftone"
    >
      <Halftone
        motif="flow_3d"
        state="idle"
        color={ink?.color}
        speed={idle.speed}
        dim={idle.dim}
        contrast={idle.contrast}
        {...AGENT_HALFTONE_GRID}
        seed={hashSlug(agent.slug)}
        followPointer={false}
      />
    </div>
  )
}
