import { UserPlus } from 'lucide-react'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { useUser } from '@renderer/context/user-context'
import { AgentSharePopover } from '@renderer/components/agents/agent-share-popover'
import { Button } from '@renderer/components/ui/button'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { MemberRosterPopover } from '@renderer/components/sharing/member-roster-popover'

/** A compact member stack with roster and invite access, independent of navigation. */
export function SidebarMemberIndicator({ agentSlug, agentName, memberCount, maxFaces = 4, variant = 'sidebar', className }: {
  agentSlug: string
  agentName: string
  memberCount: number
  /** Total circle limit, including the overflow circle when needed. */
  maxFaces?: number
  /** The sidebar's agent rows, or Agent Home's title row (bigger, page colours, roster below). */
  variant?: 'sidebar' | 'page'
  className?: string
}) {
  const { data: members, isLoading, isError, refetch } = useAgentMembers(agentSlug, memberCount > 1)
  // Test ids keep the sidebar's names there; Agent Home's are its own, as both show at once.
  const testId = variant === 'sidebar' ? 'sidebar-members' : 'agent-members'
  const { isAuthMode, isAdmin, canAdminAgent } = useUser()
  const canInvite = isAuthMode && (isAdmin || canAdminAgent(agentSlug))
  const count = members?.length ?? memberCount
  if (count < 2) return null

  return (
    <MemberRosterPopover
      users={members ?? []} count={count} maxFaces={maxFaces} variant={variant} className={className}
      label={`${count} members of ${agentName}`} rosterLabel={`${agentName} members`}
      testIds={{ trigger: `${testId}-${agentSlug}`, count: `${testId}-count-${agentSlug}`, list: `${testId}-list-${agentSlug}` }}
    >
      {/* No "N members" title: the list says it. Invite, for those who can,
          sits at the top right. */}
      {canInvite && (
        <div className="flex justify-end px-2 py-1.5">
          <AgentSharePopover
            agentSlug={agentSlug}
            agentName={agentName}
            trigger={(
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="h-6 px-2 text-[11px] [&_svg]:size-3"
                data-testid={`${testId}-invite-${agentSlug}`}
              >
                <UserPlus aria-hidden="true" />
                Invite
              </Button>
            )}
          />
        </div>
      )}
      {isLoading && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Loading members…</p>}
      {isError && <button type="button" onClick={() => void refetch()} className="m-2 rounded text-xs text-muted-foreground underline outline-none focus-visible:ring-2 focus-visible:ring-ring">Retry members</button>}
      {members && (
        <ul className="max-h-80 overflow-y-auto" aria-label="All agent members">
          {members.map(member => (
            <li key={member.id} className="flex items-center gap-2 px-2 py-2">
              <UserAvatar user={member} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{member.name || member.email}</p>
                <p className="truncate text-[11px] text-muted-foreground">{member.email}</p>
              </div>
              <span className="text-[11px] capitalize text-muted-foreground">{member.role}</span>
            </li>
          ))}
        </ul>
      )}
    </MemberRosterPopover>
  )
}
