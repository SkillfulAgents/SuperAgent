import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ApiAgent } from '@renderer/hooks/use-agents'

// EXPERIMENT: "every agent" drawn as the agents themselves, circling slowly. Not for merge.
const MAX = 6

/** Up to six agents on a ring that turns once every 24 seconds. Each avatar turns back so it stays upright. */
export function AgentOrbit({ agents, size }: { agents: readonly Pick<ApiAgent, 'slug' | 'avatar'>[]; size: number }) {
  const ring = agents.slice(0, MAX)
  const mini = Math.round(size * 0.36)
  const radius = (size - mini) / 2
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <span className="absolute inset-0 animate-[spin_24s_linear_infinite] motion-reduce:animate-none">
        {ring.map((agent, i) => {
          const angle = (360 / ring.length) * i
          return (
            <span key={agent.slug} className="absolute left-1/2 top-1/2" style={{ transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${radius}px) rotate(-${angle}deg)` }}>
              <span className="block animate-[spin_24s_linear_infinite_reverse] motion-reduce:animate-none">
                <AgentAvatar agent={agent} size={mini} />
              </span>
            </span>
          )
        })}
      </span>
    </span>
  )
}
