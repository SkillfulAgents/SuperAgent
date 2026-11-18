import { Bot } from 'lucide-react'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'

/**
 * An agent's orb where a person's face would be, at the same size: member
 * lists and invite chips that hold people and agents together. An agent with
 * no avatar gets a robot in a person-sized circle, so its row keeps its shape.
 */
export function AgentFace({ agent, size = 28 }: {
  agent: { slug: string; avatar?: AgentAvatarData | null }
  size?: number
}) {
  if (!agent.avatar) {
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" style={{ width: size, height: size }}>
        <Bot style={{ width: size * 0.6, height: size * 0.6 }} aria-hidden />
      </span>
    )
  }
  return <AgentAvatar agent={{ slug: agent.slug, avatar: agent.avatar }} size={size} />
}
