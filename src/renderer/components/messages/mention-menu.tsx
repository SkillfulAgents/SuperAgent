import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { cn } from '@shared/lib/utils/cn'
import { apiFetch } from '@renderer/lib/api'
import type { Chip } from '@renderer/lib/chip-marker'
import { useUser } from '@renderer/context/user-context'
import { Popover, PopoverAnchor, PopoverContent } from '@renderer/components/ui/popover'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ChipContext, ChipPickerHandle, ChipPickerProps } from './composer-chips'

export type MentionCandidate =
  | { kind: 'user'; id: string; name: string; email: string; image: string | null; hasAccess: boolean }
  | { kind: 'agent'; slug: string; displaySlug: string; name: string; avatar?: AgentAvatarData | null }

const MAX_CANDIDATES = 8

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

function candidateChip(candidate: MentionCandidate): Chip {
  return candidate.kind === 'user'
    ? { kind: 'user', referent: candidate.id, label: candidate.name }
    : { kind: 'agent', referent: candidate.slug, label: candidate.name }
}

/** The `@` picker: teammates and agents in one list, at the caret. */
export const MentionMenu = forwardRef<ChipPickerHandle, ChipPickerProps>(function MentionMenu(
  { query, context, anchor, onPick, onDismiss },
  ref,
) {
  const candidates = useMentionCandidates(context, query)
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
            <button
              key={candidate.kind === 'user' ? `user:${candidate.id}` : `agent:${candidate.slug}`}
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              role="option"
              aria-selected={index === active}
              data-testid={candidate.kind === 'user' ? `mention-option-user-${candidate.id}` : `mention-option-agent-${candidate.slug}`}
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
                : candidate.avatar
                  ? <AgentAvatar agent={candidate} size={20} />
                  : <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {candidate.kind === 'agent' ? 'Agent' : candidate.hasAccess ? candidate.email : 'No access yet'}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
})
