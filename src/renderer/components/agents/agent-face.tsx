import type { CSSProperties } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { avatarSource, orbGround, ORB_ON_GROUND_FILL } from '@renderer/components/agents/agent-avatar/avatar-source'

/** In the app the ground sits beside people's saturated faces, so it keeps more of the orb's colour than an app icon's. */
const FACE_GROUND_PALENESS = 0.6

/**
 * An agent's orb where a person's face would be, at the same size: member
 * lists, invite chips and member stacks that hold people and agents together.
 * `circled` puts the orb on a round ground in its own colour, as its app icon
 * does, so it sits among round faces as one of them whatever its shape.
 */
export function AgentFace({ agent, size = 28, circled = false, className, style }: {
  agent: { slug: string; avatar?: AgentAvatarData | null }
  size?: number
  circled?: boolean
  className?: string
  /** Merged over the face's own (a stack's cut-out mask, say). */
  style?: CSSProperties
}) {
  if (!agent.avatar) {
    return (
      <span
        className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground', className)}
        style={{ width: size, height: size, ...style }}
      >
        <Bot style={{ width: size * 0.6, height: size * 0.6 }} aria-hidden />
      </span>
    )
  }
  const orb = <AgentAvatar agent={{ slug: agent.slug, avatar: agent.avatar }} size={circled ? size * ORB_ON_GROUND_FILL : size} />
  return circled ? (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-full', className)}
      style={{ width: size, height: size, background: orbGround(avatarSource(agent.avatar).orb, FACE_GROUND_PALENESS), ...style }}
    >
      {orb}
    </span>
  ) : (
    <span className={cn('flex shrink-0', className)} style={{ width: size, height: size, ...style }}>
      {orb}
    </span>
  )
}
