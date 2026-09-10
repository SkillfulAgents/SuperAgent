import { useEffect, useRef, useState } from 'react'
import { UserPlus } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { useUser } from '@renderer/context/user-context'
import { AgentSharePopover } from '@renderer/components/agents/agent-share-popover'
import { Button } from '@renderer/components/ui/button'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

const AVATAR_SIZE = 16
const OVERFLOW_SIZE = 17

/** A compact member stack with roster and invite access, independent of navigation. */
export function SidebarMemberIndicator({ agentSlug, agentName, memberCount, maxFaces = 3, selected = false }: {
  agentSlug: string
  agentName: string
  memberCount: number
  /** Total circle limit, including the overflow circle when needed. */
  maxFaces?: number
  selected?: boolean
}) {
  const { data: members, isLoading, isError, refetch } = useAgentMembers(agentSlug, memberCount > 1)
  const isMobile = useIsMobile()
  const { isAuthMode, isAdmin, canAdminAgent } = useUser()
  const canInvite = isAuthMode && (isAdmin || canAdminAgent(agentSlug))
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const count = members?.length ?? memberCount
  const circleLimit = Math.max(1, maxFaces)
  const faces = members?.slice(0, count > circleLimit ? circleLimit - 1 : circleLimit) ?? []
  const remaining = count - faces.length
  const ringColor = selected ? 'ring-sidebar-accent' : 'ring-sidebar'

  function clearTimer() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  function close() {
    clearTimer()
    setOpen(false)
    setPinned(false)
  }
  function leave() {
    clearTimer()
    if (!pinned && document.activeElement !== triggerRef.current && !contentRef.current?.contains(document.activeElement)) {
      timer.current = setTimeout(() => setOpen(false), 160)
    }
  }
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  if (count < 2) return null

  return (
    <Popover open={open} onOpenChange={next => next ? setOpen(true) : close()}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="relative z-10 inline-flex h-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={`${count} members of ${agentName}`}
          data-testid={`sidebar-members-${agentSlug}`}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => {
            // Keep the surrounding sortable row from treating roster activation
            // as the beginning of a keyboard drag.
            if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
          }}
          onPointerEnter={event => {
            if (event.pointerType === 'touch' || event.buttons !== 0) return
            clearTimer()
            timer.current = setTimeout(() => setOpen(true), 180)
          }}
          onPointerLeave={leave}
          onFocus={() => { clearTimer(); setOpen(true) }}
          onBlur={event => {
            if (!pinned && !contentRef.current?.contains(event.relatedTarget)) {
              clearTimer()
              setOpen(false)
            }
          }}
          onClick={event => {
            event.preventDefault()
            clearTimer()
            setOpen(!pinned)
            setPinned(!pinned)
          }}
        >
          <span aria-hidden="true" className="pointer-events-none flex items-center pl-0.5 pr-1">
            {faces.map(member => (
              <UserAvatar key={member.id} user={member} size={AVATAR_SIZE} className={cn('-ml-1 first:ml-0 ring-1', ringColor)} />
            ))}
            {remaining > 0 && (
              <span
                className={cn('relative -ml-1 first:ml-0 inline-flex shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,hsl(var(--sidebar-foreground))_15%,hsl(var(--sidebar-background)))] text-[8px] font-medium leading-none tabular-nums text-sidebar-foreground ring-1', ringColor)}
                style={{ width: OVERFLOW_SIZE, height: OVERFLOW_SIZE }}
              >+{remaining}</span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        side={isMobile ? 'bottom' : 'right'}
        sideOffset={12}
        collisionPadding={12}
        className="w-[304px] max-w-[calc(100vw-24px)] p-2"
        aria-label={`${agentName} members`}
        data-testid={`sidebar-members-list-${agentSlug}`}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onPointerEnter={clearTimer}
        onPointerLeave={leave}
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <p className="text-xs font-medium">{count} members</p>
          {canInvite && (
            <AgentSharePopover
              agentSlug={agentSlug}
              agentName={agentName}
              trigger={(
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-6 px-2 text-[11px] [&_svg]:size-3"
                  data-testid={`sidebar-members-invite-${agentSlug}`}
                  // Keep the roster mounted if the press blurs its trigger before click.
                  onPointerDownCapture={() => {
                    clearTimer()
                    setPinned(true)
                  }}
                  onClick={() => {
                    clearTimer()
                    setPinned(true)
                  }}
                >
                  <UserPlus aria-hidden="true" />
                  Invite
                </Button>
              )}
            />
          )}
        </div>
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
      </PopoverContent>
    </Popover>
  )
}
