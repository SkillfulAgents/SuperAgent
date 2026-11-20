import type { CSSProperties } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { avatarSource, ORB_ON_GROUND_FILL } from '@renderer/components/agents/agent-avatar/avatar-source'

/** A little of the surface behind comes through the ground. The orb stays whole. */
const FACE_GROUND_OPACITY = 0.5

/** A `#RRGGBB` colour at an opacity, as `#RRGGBBAA`. */
function atOpacity(hex: string, opacity: number): string {
  return hex + Math.round(opacity * 255).toString(16).padStart(2, '0').toUpperCase()
}

/**
 * An agent where a person's face would be, at the same size: its orb, held
 * still, on a round ground of its own rim colour. Among round faces it reads
 * as one of them whatever its shape, and the lighter core is what shows.
 * Its Slack app icon stands on a pale wash of the same rim (`orbGround`); a
 * face this small among people needs the colour itself.
 */
export function AgentFace({ agent, size = 28, className, style }: {
  agent: { slug: string; avatar: AgentAvatarData }
  size?: number
  className?: string
  /** Merged over the face's own (a stack's cut-out mask, say). */
  style?: CSSProperties
}) {
  return (
    <span
      data-agent-face={agent.slug}
      className={cn('flex shrink-0 items-center justify-center rounded-full', className)}
      style={{ width: size, height: size, background: atOpacity(avatarSource(agent.avatar).orb.rim, FACE_GROUND_OPACITY), ...style }}
    >
      <AgentAvatar agent={agent} size={Math.round(size * ORB_ON_GROUND_FILL)} still />
    </span>
  )
}
