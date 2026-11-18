import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'

/**
 * An agent's orb where a person's face would be, at the same size: member
 * lists and invite chips that hold people and agents together. The slot keeps
 * its size when an older deployment sends no avatar, so names line up.
 */
export function AgentFace({ agent, size = 28 }: {
  agent: { slug: string; avatar?: AgentAvatarData | null }
  size?: number
}) {
  return (
    <span className="flex shrink-0" style={{ width: size, height: size }}>
      <AgentAvatar agent={agent} size={size} />
    </span>
  )
}
