import type { CSSProperties } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { hexMix } from '@shared/lib/types/agent-avatar-orbs'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'

/** How much of a circled face the orb fills, as on its app icon (`agent-app-icon.ts`). */
const ORB_ON_GROUND_FILL = 0.7
/** How far the ground takes the orb's rim toward white: less than an app icon's, beside people's saturated faces. */
const FACE_GROUND_PALENESS = 0.6

/**
 * An agent's orb where a person's face would be, at the same size: member
 * lists, invite chips and member stacks that hold people and agents together.
 * `circled` puts the orb on a round ground in its own colour, as its app icon
 * does, so it sits among round faces as one of them whatever its shape. The
 * slot keeps its size when an older deployment sends no avatar.
 */
export function AgentFace({ agent, size = 28, circled = false, className, style }: {
  agent: { slug: string; avatar?: AgentAvatarData | null }
  size?: number
  circled?: boolean
  className?: string
  /** Merged over the face's own (a stack's cut-out mask, say). */
  style?: CSSProperties
}) {
  return (
    <span
      className={cn('flex shrink-0', circled && 'items-center justify-center rounded-full', className)}
      style={{ width: size, height: size, background: circled && agent.avatar ? hexMix(avatarSource(agent.avatar).orb.rim, '#FFFFFF', FACE_GROUND_PALENESS) : undefined, ...style }}
    >
      <AgentAvatar agent={agent} size={circled ? size * ORB_ON_GROUND_FILL : size} />
    </span>
  )
}
