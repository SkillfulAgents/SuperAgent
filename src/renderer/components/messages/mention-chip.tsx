import { useMemo } from 'react'
import { Bot, MessageSquare } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import type { Mention } from '@shared/lib/utils/mentions'
import type { Chip } from '@renderer/lib/chip-marker'
import { useAgents } from '@renderer/hooks/use-agents'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { AppLink } from '@renderer/components/ui/app-link'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ChipAgent, ChipContext, ChipPerson } from './composer-chips'

/** A mention reads the same in the composer and in a sent bubble. */
export const MENTION_CHIP_CLASS =
  'inline-flex items-baseline gap-1 rounded-full bg-violet-500/10 px-1.5 font-medium text-violet-700 dark:bg-violet-400/15 dark:text-violet-300 [&_[data-chip-icon]]:self-center'

const AVATAR_SIZE = 18

// Plain objects, so React Query keeps the result when a refetch (an agent's status) changes nothing here.
function toChipAgents(agents: ApiAgent[]): ChipAgent[] {
  return agents.map((agent) => ({ slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, avatar: agent.avatar }))
}

/** The people and agents mentions can name, as `ChipContext` carries them. */
export function useMentionDirectory(agentSlug: string | undefined): Pick<ChipContext, 'members' | 'agents'> {
  const { data: memberList } = useAgentMembers(agentSlug ?? '', !!agentSlug)
  const { data: agentList } = useAgents({ select: toChipAgents, poll: false })
  const members = useMemo(
    () => memberList && new Map<string, ChipPerson>(memberList.map((member) => [member.id, member])),
    [memberList],
  )
  const agents = useMemo(() => agentList && new Map(agentList.map((agent) => [agent.slug, agent])), [agentList])
  return useMemo(() => ({ members, agents }), [members, agents])
}

/** An agent by any slug the agents tools accept: its id, or a display slug ending in it. */
export function agentForSlug(agents: ReadonlyMap<string, ChipAgent> | undefined, slug: string): ChipAgent | undefined {
  return agents?.get(slug) ?? agents?.get(slug.slice(slug.lastIndexOf('-') + 1))
}

function PersonAvatar({ id, name, members }: { id: string; name: string; members?: ReadonlyMap<string, ChipPerson> }) {
  return <UserAvatar user={members?.get(id) ?? { id, name }} size={AVATAR_SIZE} />
}

function AgentIcon({ agent }: { agent: ChipAgent | undefined }) {
  return agent?.avatar
    ? <AgentAvatar agent={agent} size={AVATAR_SIZE} />
    : <Bot className="size-4 shrink-0" aria-hidden />
}

export function UserMentionIcon({ chip, context }: { chip: Chip; context: ChipContext }) {
  return <PersonAvatar id={chip.referent} name={chip.label} members={context.members} />
}

export function AgentMentionIcon({ chip, context }: { chip: Chip; context: ChipContext }) {
  return <AgentIcon agent={agentForSlug(context.agents, chip.referent)} />
}

export function ChatMentionIcon() {
  return <MessageSquare className="size-3.5 shrink-0" aria-hidden />
}

/** A mention in a sent message: the same chip the composer drew. A chat opens on click. */
export function MentionChip({ mention, agentSlug }: { mention: Mention; agentSlug?: string }) {
  const { members, agents } = useMentionDirectory(agentSlug)
  if (mention.kind === 'chat' && agentSlug) {
    return (
      <AppLink
        to="/agents/$slug/sessions/$sessionId"
        params={{ slug: agentSlug, sessionId: mention.id }}
        className={cn(MENTION_CHIP_CLASS, 'hover:underline')}
        data-testid="chat-mention"
      >
        <span data-chip-icon=""><ChatMentionIcon /></span>
        @{mention.name}
      </AppLink>
    )
  }
  return (
    <span className={MENTION_CHIP_CLASS} data-testid={`${mention.kind}-mention`}>
      <span data-chip-icon="">
        {mention.kind === 'user'
          ? <PersonAvatar id={mention.id} name={mention.name} members={members} />
          : mention.kind === 'chat'
            ? <ChatMentionIcon />
            : <AgentIcon agent={agentForSlug(agents, mention.slug)} />}
      </span>
      @{mention.name}
    </span>
  )
}
