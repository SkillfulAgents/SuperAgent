import type { CSSProperties } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'

/**
 * An agent's orb where a person's face would be, at the same size: member
 * lists, invite chips and member stacks that hold people and agents together.
 * The slot keeps its size when an older deployment sends no avatar.
 */
export function AgentFace({ agent, size = 28, className, style }: {
  agent: { slug: string; avatar?: AgentAvatarData | null }
  size?: number
  className?: string
  /** Merged over the face's own (a stack's cut-out mask, say). */
  style?: CSSProperties
}) {
  return (
    <span className={cn('flex shrink-0', className)} style={{ width: size, height: size, ...style }}>
      <AgentAvatar agent={agent} size={size} />
    </span>
  )
}
