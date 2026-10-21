import { Fragment, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Bot, MessageSquare } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { cn } from '@shared/lib/utils/cn'
import { apiFetch } from '@renderer/lib/api'
import type { Chip } from '@renderer/lib/chip-marker'
import { useUser } from '@renderer/context/user-context'
import { useSessions } from '@renderer/hooks/use-sessions'
import { chatUseScores, recordChatUse } from '@renderer/lib/chat-usage'
import { Popover, PopoverAnchor, PopoverContent } from '@renderer/components/ui/popover'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ChipContext, ChipPickerHandle, ChipPickerProps } from './composer-chips'

export type MentionCandidate =
  | { kind: 'user'; id: string; name: string; email: string; image: string | null; hasAccess: boolean }
  | { kind: 'agent'; slug: string; displaySlug: string; name: string; avatar?: AgentAvatarData | null }
  | { kind: 'chat'; id: string; name: string; lastActivityAt: Date | string }

const MAX_CANDIDATES = 8
const MAX_CHATS = 5

/** 0: the name starts with the query; 1: a word of the name or the email does; 2: it is in there; null: no match. */
function rank(query: string, name: string, secondary: string): number | null {
  if (!query) return 0
  const lowerName = name.toLowerCase()
  if (lowerName.startsWith(query)) return 0
  if (lowerName.split(/\s+/).some((word) => word.startsWith(query)) || secondary.toLowerCase().startsWith(query)) return 1
  if (lowerName.includes(query) || secondary.toLowerCase().includes(query)) return 2
  return null
}

/**
 * Who `@query` can name: the agent's people (and, for whoever can share it,
 * anyone it could be shared with), alongside the other agents. Teammates
 * exist in auth mode only.
 */
function useMentionCandidates({ agentSlug = '', members, agents }: ChipContext, query: string): MentionCandidate[] {
  const { user, isAuthMode, isAdmin, canAdminAgent } = useUser()
  const canShare = isAuthMode && (isAdmin || canAdminAgent(agentSlug))

  const [searched, setSearched] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 150)
    return () => clearTimeout(timer)
  }, [query])
  // The share popover's own search: people the agent could be shared with.
  const { data: outsiders } = useQuery<Array<{ id: string; name: string; email: string; image: string | null }>>({
    queryKey: ['agent-invite-candidates', agentSlug, searched],
    queryFn: async () => {
      const qs = searched ? `?q=${encodeURIComponent(searched)}` : ''
      const res = await apiFetch(`/api/agents/${agentSlug}/access/search-users${qs}`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: canShare,
    placeholderData: (previous) => previous,
  })

  return useMemo(() => {
    const lowerQuery = query.toLowerCase()
    const ranked: Array<{ candidate: MentionCandidate; rank: number }> = []
    const people = [
      ...[...(members?.values() ?? [])].map((member) => ({ ...member, hasAccess: true })),
      ...(outsiders ?? []).filter((person) => !members?.has(person.id)).map((person) => ({ ...person, hasAccess: false })),
    ]
    for (const person of people) {
      if (person.id === user?.id) continue
      const email = person.email ?? ''
      const score = rank(lowerQuery, person.name, email)
      if (score !== null) ranked.push({ candidate: { kind: 'user', id: person.id, name: person.name, email, image: person.image ?? null, hasAccess: person.hasAccess }, rank: score })
    }
    for (const agent of agents?.values() ?? []) {
      if (agent.slug === agentSlug || agent.displaySlug === agentSlug) continue
      const score = rank(lowerQuery, agent.name, agent.displaySlug)
      if (score !== null) ranked.push({ candidate: { kind: 'agent', slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, avatar: agent.avatar }, rank: score })
    }
    // Best match first; people ahead of agents within a rank.
    return ranked
      .sort((a, b) => a.rank - b.rank || (a.candidate.kind === b.candidate.kind ? 0 : a.candidate.kind === 'user' ? -1 : 1))
      .slice(0, MAX_CANDIDATES)
      .map(({ candidate }) => candidate)
  }, [query, members, outsiders, agents, user?.id, agentSlug])
}

/** Like `rank`, with 3 for the query's letters in order anywhere in the title (`q3rev` → "Q3 revenue"). */
export function chatRank(query: string, title: string): number | null {
  const ranked = rank(query, title, '')
  if (ranked !== null) return ranked
  const lowerTitle = title.toLowerCase()
  let at = 0
  for (const char of query.replace(/\s+/g, '')) {
    at = lowerTitle.indexOf(char, at) + 1
    if (at === 0) return null
  }
  return 3
}

/**
 * This agent's chats `@query` can name, other than the one open: the ones used
 * closest title match first, then the ones used most here (see
 * `chatUseScores`), then the latest. The list loads only
 * while the picker is open.
 */
function useChatCandidates({ agentSlug = '', sessionId: openSessionId }: ChipContext, query: string): MentionCandidate[] {
  const { data: sessions } = useSessions(agentSlug || null, { staleTime: 30_000 })
  return useMemo(() => {
    const lowerQuery = query.toLowerCase()
    const score = chatUseScores()
    return (sessions ?? [])
      .flatMap((session) => {
        if (session.id === openSessionId || !session.name.trim()) return []
        const match = chatRank(lowerQuery, session.name)
        return match === null ? [] : [{ session, match, used: score(session.id) }]
      })
      .sort((a, b) => a.match - b.match
        || b.used - a.used
        || new Date(b.session.lastActivityAt).getTime() - new Date(a.session.lastActivityAt).getTime())
      .slice(0, MAX_CHATS)
      .map(({ session }) => ({ kind: 'chat' as const, id: session.id, name: session.name, lastActivityAt: session.lastActivityAt }))
  }, [sessions, query, openSessionId])
}

function candidateChip(candidate: MentionCandidate): Chip {
  if (candidate.kind === 'chat') recordChatUse(candidate.id)
  return candidate.kind === 'user'
    ? { kind: 'user', referent: candidate.id, label: candidate.name }
    : candidate.kind === 'chat'
      ? { kind: 'chat', referent: candidate.id, label: candidate.name }
      : { kind: 'agent', referent: candidate.slug, label: candidate.name }
}

const candidateKey = (candidate: MentionCandidate) =>
  candidate.kind === 'agent' ? `agent:${candidate.slug}` : `${candidate.kind}:${candidate.id}`

/** The `@` picker: teammates and agents in one list, then this agent's chats, at the caret. */
export const MentionMenu = forwardRef<ChipPickerHandle, ChipPickerProps>(function MentionMenu(
  { query, context, anchor, onPick, onDismiss },
  ref,
) {
  const named = useMentionCandidates(context, query)
  const chats = useChatCandidates(context, query)
  const candidates = useMemo(() => [...named, ...chats], [named, chats])
  const [selected, setSelected] = useState(0)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => setSelected(0), [query])
  const active = Math.min(selected, Math.max(0, candidates.length - 1))

  useEffect(() => {
    optionRefs.current[active]?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (candidates.length === 0) return false
      switch (event.key) {
        case 'ArrowDown':
          setSelected((active + 1) % candidates.length)
          return true
        case 'ArrowUp':
          setSelected((active - 1 + candidates.length) % candidates.length)
          return true
        case 'Enter':
        case 'Tab':
          onPick(candidateChip(candidates[active]))
          return true
        case 'Escape':
          onDismiss()
          return true
        default:
          return false
      }
    },
  }), [active, candidates, onDismiss, onPick])

  if (candidates.length === 0) return null

  return (
    <Popover open>
      <PopoverAnchor virtualRef={{ current: anchor }} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="max-h-72 w-72 overflow-y-auto p-1"
        // The caret stays in the editor: keys reach the menu through it.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={onDismiss}
        onInteractOutside={onDismiss}
      >
        <div role="listbox" aria-label="Mention someone" data-testid="mention-menu">
          {candidates.map((candidate, index) => (
            <Fragment key={candidateKey(candidate)}>
            {index === named.length && (
              <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground" role="presentation">Chats</div>
            )}
            <button
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              role="option"
              aria-selected={index === active}
              data-testid={`mention-option-${candidateKey(candidate).replace(':', '-')}`}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                index === active && 'bg-accent text-accent-foreground',
              )}
              onMouseEnter={() => setSelected(index)}
              // Picking must not move focus out of the editor.
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(candidateChip(candidate))
              }}
            >
              {candidate.kind === 'user'
                ? <UserAvatar user={candidate} size={20} />
                : candidate.kind === 'chat'
                  ? <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  : candidate.avatar
                  ? <AgentAvatar agent={candidate} size={20} />
                  : <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {candidate.kind === 'agent'
                  ? 'Agent'
                  : candidate.kind === 'chat'
                    ? formatDistanceToNow(new Date(candidate.lastActivityAt), { addSuffix: true })
                    : candidate.hasAccess ? candidate.email : 'No access yet'}
              </span>
            </button>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
})
