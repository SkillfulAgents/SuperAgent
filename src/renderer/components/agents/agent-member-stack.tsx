import { useState, type ReactNode } from 'react'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

function MemberFace({ member, open, offset, onOpenChange }: {
  member: AgentMember; open: boolean; offset: number; onOpenChange: (open: boolean) => void
}) {
  return (
    <Tooltip open={open} onOpenChange={onOpenChange} disableHoverableContent>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${member.name || member.email}, ${member.email}, ${member.role}`}
          onClick={() => onOpenChange(true)}
          className="group/member relative -ml-2 first:ml-0 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:z-10 focus:z-10 focus-visible:outline-none"
          data-testid={`agent-member-${member.id}`}
        >
          {/* Keep the hit areas stationary when spacing the faces. Moving the
              buttons themselves can leave the pointer over the previous face. */}
          <span className="pointer-events-none flex rounded-full ring-2 ring-background transition-transform duration-150 group-focus-visible/member:ring-ring motion-reduce:transition-none" style={{ transform: `translate(${offset}px, ${open ? -4 : 0}px)` }} data-testid="member-avatar-visual">
            <UserAvatar user={member} size={28} />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[min(20rem,calc(100vw-2rem))] break-words">
        <p className="font-medium">{member.name || member.email}</p>
        <p className="text-xs opacity-80">{member.email}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function AgentMemberStack({ agentSlug, renderShareControl }: {
  agentSlug: string
  renderShareControl?: (isShared: boolean) => ReactNode
}) {
  const { data: members, isLoading, isError, refetch } = useAgentMembers(agentSlug)
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIndex = members?.findIndex((member) => member.id === activeId) ?? -1
  const isShared = (members?.length ?? 0) > 1
  const shareControl = renderShareControl?.(isShared)
  if (!isLoading && !isError && !isShared && !shareControl) return null
  return (
    <div className={isShared ? "flex shrink-0 items-center px-2 py-1" : "flex shrink-0 items-center gap-2"} data-testid={isShared ? "agent-member-stack" : undefined} role={isShared ? "group" : undefined} aria-label={isShared ? "Agent members" : undefined}>
      {isLoading ? <span role="status" className={isShared ? "mr-4 text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>Loading members…</span>
        : isError ? <button className={isShared ? "mr-4 text-xs text-muted-foreground underline" : "text-xs text-muted-foreground underline"} onClick={() => void refetch()}>Retry members</button>
        : isShared && members ? (
          <TooltipProvider delayDuration={150}>
            {members.slice(0, 5).map((member, index) => (
              <MemberFace
                key={member.id} member={member} open={activeId === member.id}
                offset={activeIndex < 0 || activeIndex === index ? 0 : index < activeIndex ? -8 : 8}
                onOpenChange={(open) => setActiveId((current) => open ? member.id : current === member.id ? null : current)}
              />
            ))}
            {members.length > 5 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="relative -ml-2 flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full border bg-background px-1.5 text-xs font-medium ring-2 ring-background transition-transform duration-150 motion-reduce:transition-none hover:z-10 hover:bg-accent focus:z-10 focus-visible:outline-none focus-visible:ring-ring" style={{ transform: `translateX(${activeIndex < 0 ? 0 : 8}px)` }} aria-label={`Show all ${members.length} members`} data-testid="agent-members-overflow">
                    +{members.length - 5}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] p-2" data-testid="agent-members-list">
                  <p className="px-2 py-1 text-xs font-medium">{members.length} members</p>
                  <ul className="max-h-72 overflow-y-auto" aria-label="All agent members">
                    {members.map((member) => (
                      <li key={member.id} className="flex items-center gap-2 px-2 py-2">
                        <UserAvatar user={member} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{member.name || member.email}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{member.email}</p>
                        </div>
                        <span className="text-[11px] capitalize text-muted-foreground">{member.role}</span>
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            )}
          </TooltipProvider>
        ) : null}
      {shareControl && (
        <div className={isShared ? "relative -ml-2 first:ml-0 flex shrink-0 transition-transform duration-150 motion-reduce:transition-none hover:z-10 focus-within:z-10" : "flex shrink-0"} style={isShared ? { transform: `translateX(${activeIndex < 0 ? 0 : 8}px)` } : undefined}>
          {shareControl}
        </div>
      )}
    </div>
  )
}
