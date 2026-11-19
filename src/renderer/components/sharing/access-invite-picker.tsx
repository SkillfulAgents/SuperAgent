import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Check, Loader2, Users, X } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { NotOnGamutBadge } from '@renderer/components/agents/not-on-gamut-badge'
import { accessUrl, useInviteCandidates, type ShareTarget } from '@renderer/hooks/use-invite-candidates'
import { apiFetch } from '@renderer/lib/api'
import { cn } from '@shared/lib/utils/cn'
import { candidateKey, type InviteCandidate } from '@shared/lib/team-directory/candidate-schema'
import type { AgentRole } from '@shared/lib/types/agent'

interface AccessMember {
  id: string | null
  name: string
  email?: string
  image?: string | null
  invited?: boolean
}

interface AccessInvitePickerProps<T extends AccessMember> {
  target: ShareTarget
  members: readonly T[]
  renderMemberAction: (member: T) => ReactNode
  /** Omit the role for a read-only roster. */
  role?: AgentRole
  roleControl?: ReactNode
  onGranted: () => void
  onComplete?: () => void
  inputRef?: RefObject<HTMLInputElement>
  additionalMembers?: ReactNode
  membersStatus?: ReactNode
  error?: string | null
}

export function AccessInvitePicker<T extends AccessMember>({
  target, members, renderMemberAction, role, roleControl, onGranted, onComplete, inputRef, membersStatus, additionalMembers, error,
}: AccessInvitePickerProps<T>) {
  const { user } = useUser()
  const localInput = useRef<HTMLInputElement>(null)
  const input = inputRef ?? localInput
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<InviteCandidate[]>([])
  const [inviteError, setInviteError] = useState('')
  const candidates = useInviteCandidates(target, query, !!role)
  const grant = useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (batch: { people: InviteCandidate[]; role: AgentRole }) => {
      const succeeded = new Set<string>()
      const failures: string[] = []
      for (const person of batch.people) {
        try {
          const identity = person.kind === 'directory' ? { directoryRef: person.directoryRef } : { userId: person.id }
          const response = await apiFetch(accessUrl(target), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, role: batch.role }),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => null)
            throw new Error(body?.error ?? 'Could not grant access')
          }
          succeeded.add(candidateKey(person))
        } catch (err) {
          failures.push(`${person.name}: ${err instanceof Error ? err.message : 'Could not grant access'}`)
        }
      }
      return { succeeded, failures }
    },
    onMutate: () => setInviteError(''),
    onSuccess: ({ succeeded, failures }) => {
      if (succeeded.size) onGranted()
      setSelected(previous => previous.filter(person => !succeeded.has(candidateKey(person))))
      setInviteError(failures.join('\n'))
      if (!failures.length) {
        setQuery('')
        onComplete?.()
      }
    },
  })

  const filter = query.trim().toLowerCase()
  const matches = (person: { name: string; email?: string }) =>
    person.name.toLowerCase().includes(filter) || !!person.email?.toLowerCase().includes(filter)
  const visibleMembers = members.filter(matches)
  const ids = new Set(members.map(m => m.id))
  const emails = new Set(members.map(m => m.email?.toLowerCase()))
  const suggestions = (candidates.data ?? []).filter(person => matches(person) &&
    (person.kind === 'directory' ? !emails.has(person.email.toLowerCase()) : !ids.has(person.id)))
  const selectedIds = new Set(selected.map(candidateKey))
  function toggle(person: InviteCandidate) {
    const key = candidateKey(person)
    setSelected(previous => previous.some(p => candidateKey(p) === key)
      ? previous.filter(p => candidateKey(p) !== key) : [...previous, person])
    setQuery('')
    input.current?.focus()
  }

  return <>
    {role && <div className="px-3 pb-4 pt-5">
      <div className="flex items-start gap-2">
        <div className="flex min-h-8 min-w-0 flex-1 items-start gap-1 rounded-item border px-1.5 py-0.5 has-[input:focus]:ring-1 has-[input:focus]:ring-ring">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selected.map(person => {
              const key = candidateKey(person)
              return <span key={key} className={cn('flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]',
                person.notOnGamut && 'border border-dashed border-muted-foreground/50 bg-transparent')} data-testid={`invite-chip-${key}`}>
                <UserAvatar user={{ ...person, id: key }} size={16} />
                <span className="max-w-32 truncate">{person.name}</span>
                <button type="button" aria-label={`Remove ${person.name} from invite`} disabled={grant.isPending}
                  className="text-muted-foreground hover:text-foreground" onClick={() => toggle(person)}><X className="size-3" /></button>
              </span>
            })}
            <input ref={input} aria-label="Invite by name or email" placeholder={selected.length ? '' : 'Invite by name or email...'}
              value={query} onChange={event => setQuery(event.target.value)} disabled={grant.isPending}
              onKeyDown={event => {
                if (event.key === 'Backspace' && !query) setSelected(previous => previous.slice(0, -1))
              }}
              className="h-6 min-w-20 flex-1 bg-transparent px-1 text-[11px] outline-none placeholder:text-muted-foreground"
              data-testid="invite-search-input" />
          </div>
          {roleControl ?? <span className="flex h-6 items-center px-1 text-[11px] capitalize text-muted-foreground">{role}</span>}
        </div>
        <Button type="button" size="sm" className="h-8 shrink-0 text-[11px]" disabled={grant.isPending}
          onClick={() => selected.length ? grant.mutate({ people: selected, role }) : input.current?.focus()} data-testid="invite-add-button">
          {grant.isPending ? <Loader2 aria-label="Inviting" className="size-4 animate-spin" /> : 'Invite'}
        </Button>
      </div>
    </div>}
    {(inviteError || error) && <p role="alert" className="whitespace-pre-line px-3 pb-2 text-[11px] text-destructive">{inviteError || error}</p>}
    <div className={cn('overflow-y-auto px-1 pb-2', additionalMembers ? 'max-h-[min(60dvh,28rem)]' : 'max-h-72')}>
      {membersStatus ?? <>
        {visibleMembers.length > 0 && <>
          <p className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">{filter ? 'Already shared with' : 'Members with access'}</p>
          {visibleMembers.map(member => <div key={member.id === null ? 'workspace' : `user:${member.id}`}
            className="flex items-center gap-2 rounded-item px-2 py-1.5 hover:bg-accent/50" data-testid={`access-entry-${member.id ?? 'workspace'}`}>
            {member.id === null ? <Users className="size-7 p-1 text-muted-foreground" /> :
              <span className={cn(member.invited && 'opacity-50')}><UserAvatar user={{ ...member, id: member.id }} /></span>}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <span className={cn('truncate', member.invited && 'opacity-50')}>{member.name}</span>
                {member.id === user?.id && <span className="text-muted-foreground"> (You)</span>}
                {member.invited && <NotOnGamutBadge label="Invite pending" />}
              </div>
              {member.email && <div className={cn('truncate text-[11px] text-muted-foreground', member.invited && 'opacity-50')}>{member.email}</div>}
            </div>
            {renderMemberAction(member)}
          </div>)}
        </>}
        {role && filter && <>
          {suggestions.length > 0 && <p className={cn('px-2 pb-1 text-[11px] text-muted-foreground', visibleMembers.length > 0 && 'pt-2')}>Not shared with</p>}
          {suggestions.map(person => {
            const key = candidateKey(person)
            const checked = selectedIds.has(key)
            return <button key={key} type="button" role="checkbox" aria-checked={checked} disabled={grant.isPending}
              onClick={() => toggle(person)} data-testid={`invite-user-result-${key}`}
              className="flex w-full items-center gap-2 rounded-item px-2 py-1.5 text-left text-[11px] hover:bg-accent">
              <span className={cn(person.notOnGamut && 'opacity-50')}><UserAvatar user={{ ...person, id: key }} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={cn('truncate', person.notOnGamut && 'opacity-50')}>{person.name}</span>
                  {person.notOnGamut && <NotOnGamutBadge />}
                </div>
                <div className={cn('truncate text-muted-foreground', person.notOnGamut && 'opacity-50')}>
                  {person.email}{person.kind === 'directory' && ` · ${person.source}`}
                </div>
              </div>
              <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary shadow', checked && 'bg-primary text-primary-foreground')}>
                {checked && <Check className="size-3" />}
              </span>
            </button>
          })}
          {candidates.isError && <p role="alert" className="px-2 py-2 text-xs text-destructive">
            Could not load people. <button type="button" className="underline" onClick={() => void candidates.refetch()}>Try again</button>
          </p>}
        </>}
        {!visibleMembers.length && (!filter || !suggestions.length) && !candidates.isError &&
          <p role="status" className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            {filter ? (candidates.isFetching ? 'Searching…' : 'No users found') : `No users have access to this ${target.kind}.`}
          </p>}
      </>}
      {!filter && additionalMembers}
    </div>
  </>
}
