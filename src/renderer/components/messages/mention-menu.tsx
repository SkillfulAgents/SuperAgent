import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { AgentAvatar as AgentAvatarData } from '@shared/lib/types/agent-avatar'
import { cn } from '@shared/lib/utils/cn'
import { apiFetch } from '@renderer/lib/api'
import type { InviteCandidate } from '@shared/lib/team-directory/candidate-schema'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import { toast } from 'sonner'
import { NotOnGamutBadge } from '@renderer/components/agents/not-on-gamut-badge'
import type { Chip } from '@renderer/lib/chip-marker'
import { useUser } from '@renderer/context/user-context'
import { Popover, PopoverAnchor, PopoverContent } from '@renderer/components/ui/popover'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ChipContext, ChipPickerHandle, ChipPickerProps } from './composer-chips'

export type MentionCandidate =
  | { kind: 'user'; id: string; name: string; email: string; image: string | null; hasAccess: boolean; notOnGamut?: boolean }
  /** Someone in a team directory with no account: picking them makes an invited one. */
  | { kind: 'directory'; directoryRef: { directoryId: string; remoteId: string }; name: string; email: string; image: string | null }
  | { kind: 'agent'; slug: string; displaySlug: string; name: string; avatar?: AgentAvatarData | null }

const KIND_ORDER: Record<MentionCandidate['kind'], number> = { user: 0, directory: 1, agent: 2 }

function candidateKey(candidate: MentionCandidate): string {
  if (candidate.kind === 'user') return `user:${candidate.id}`
  if (candidate.kind === 'agent') return `agent:${candidate.slug}`
  return `directory:${candidate.directoryRef.directoryId}:${candidate.directoryRef.remoteId}`
}

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
  const { data: outsiders } = useQuery<InviteCandidate[]>({
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
      ...[...(members?.values() ?? [])].map((member) => ({ ...member, hasAccess: true, notOnGamut: (member as Partial<AgentMember>).invited === true })),
      ...(outsiders ?? []).flatMap((person) => person.kind === 'directory' || members?.has(person.id)
        ? []
        : [{ ...person, hasAccess: false }]),
    ]
    for (const person of people) {
      if (person.id === user?.id) continue
      const email = person.email ?? ''
      const score = rank(lowerQuery, person.name, email)
      if (score !== null) ranked.push({ candidate: { kind: 'user', id: person.id, name: person.name, email, image: person.image ?? null, hasAccess: person.hasAccess, notOnGamut: person.notOnGamut }, rank: score })
    }
    for (const person of outsiders ?? []) {
      if (person.kind !== 'directory') continue
      const score = rank(lowerQuery, person.name, person.email)
      if (score !== null) ranked.push({ candidate: { kind: 'directory', directoryRef: person.directoryRef, name: person.name, email: person.email, image: person.image }, rank: score })
    }
    for (const agent of agents?.values() ?? []) {
      if (agent.slug === agentSlug || agent.displaySlug === agentSlug) continue
      const score = rank(lowerQuery, agent.name, agent.displaySlug)
      if (score !== null) ranked.push({ candidate: { kind: 'agent', slug: agent.slug, displaySlug: agent.displaySlug, name: agent.name, avatar: agent.avatar }, rank: score })
    }
    // Best match first; within a rank, accounts, then directory people, then agents.
    return ranked
      .sort((a, b) => a.rank - b.rank || KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind])
      .slice(0, MAX_CANDIDATES)
      .map(({ candidate }) => candidate)
  }, [query, members, outsiders, agents, user?.id, agentSlug])
}

function candidateChip(candidate: Exclude<MentionCandidate, { kind: 'directory' }>): Chip {
  return candidate.kind === 'user'
    ? { kind: 'user', referent: candidate.id, label: candidate.name }
    : { kind: 'agent', referent: candidate.slug, label: candidate.name }
}

/** A directory person first gets an invited account, so their chip names a user like any other. */
async function directoryChip(candidate: Extract<MentionCandidate, { kind: 'directory' }>, agentSlug: string | undefined): Promise<Chip> {
  const res = await apiFetch(`/api/agents/${agentSlug}/access/invitees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directoryRef: candidate.directoryRef }),
  })
  const body = await res.json().catch(() => null) as { id?: string; name?: string; error?: string } | null
  if (!res.ok || !body?.id) throw new Error(body?.error ?? `Couldn’t mention ${candidate.name}`)
  return { kind: 'user', referent: body.id, label: body.name ?? candidate.name }
}

const notOnGamut = (candidate: MentionCandidate) =>
  candidate.kind === 'directory' || (candidate.kind === 'user' && candidate.notOnGamut === true)

/** The `@` picker: teammates and agents in one list, at the caret. */
export const MentionMenu = forwardRef<ChipPickerHandle, ChipPickerProps>(function MentionMenu(
  { query, context, anchor, onPick, onDismiss },
  ref,
) {
  const candidates = useMentionCandidates(context, query)
  const [selected, setSelected] = useState(0)
  const picking = useRef(false)
  const pick = (candidate: MentionCandidate) => {
    if (candidate.kind !== 'directory') {
      onPick(candidateChip(candidate))
      return
    }
    if (picking.current) return
    picking.current = true
    directoryChip(candidate, context.agentSlug)
      .then(onPick, (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => { picking.current = false })
  }
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
          pick(candidates[active])
          return true
        case 'Escape':
          onDismiss()
          return true
        default:
          return false
      }
    },
  }), [active, candidates, onDismiss, onPick, context.agentSlug])

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
              key={candidateKey(candidate)}
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
                pick(candidate)
              }}
            >
              {candidate.kind === 'agent'
                ? candidate.avatar
                  ? <AgentAvatar agent={candidate} size={20} />
                  : <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                : (
                  // Someone not on Gamut yet is drawn at half strength.
                  <span className={cn(notOnGamut(candidate) && 'opacity-50')}>
                    <UserAvatar user={{ ...candidate, id: candidateKey(candidate) }} size={20} />
                  </span>
                )}
              <span className={cn('min-w-0 flex-1 truncate', notOnGamut(candidate) && 'opacity-50')}>{candidate.name}</span>
              {notOnGamut(candidate)
                ? <NotOnGamutBadge />
                : (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {candidate.kind === 'agent' ? 'Agent' : candidate.kind === 'user' && candidate.hasAccess ? candidate.email : 'No access yet'}
                  </span>
                )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
})
