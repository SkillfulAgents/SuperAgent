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

// Each circle overlaps the one before it. Rather than a ring in the
// background colour, which had to track the sidebar row's hover and selected
// fills (and can't match Agent Home's background), the circle underneath has a gap
// cut out around the next one, so what's behind shows through. Centred on the
// next circle, which starts `face - overlap` in.
function cutout(face: number, overlap: number, next: number, gap: number) {
  const radius = next / 2 + gap
  return { maskImage: `radial-gradient(circle at ${face - overlap + next / 2}px 50%, transparent ${radius}px, #000 ${radius + 0.5}px)` }
}

/**
 * Sizes and colours per surface. The sidebar's: 18px faces 8px over each other
 * with a 1px gap. Agent Home's: the same stack a step up, beside its title.
 */
const VARIANTS = {
  sidebar: {
    face: 18, count: 19, overlap: 8, gap: 0.5,
    overlapClass: '-ml-2', countText: 'text-[8px]',
    countFill: 'bg-[color-mix(in_srgb,hsl(var(--sidebar-foreground))_15%,hsl(var(--sidebar-background)))] text-sidebar-foreground',
    ring: 'focus-visible:ring-sidebar-ring',
  },
  page: {
    face: 24, count: 24, overlap: 10, gap: 1.5,
    overlapClass: '-ml-2.5', countText: 'text-[10px]',
    countFill: 'bg-[color-mix(in_srgb,hsl(var(--foreground))_10%,hsl(var(--background)))] text-foreground',
    ring: 'focus-visible:ring-ring',
  },
} as const

/** A compact member stack with roster and invite access, independent of navigation. */
export function SidebarMemberIndicator({ agentSlug, agentName, memberCount, maxFaces = 4, variant = 'sidebar', className }: {
  agentSlug: string
  agentName: string
  memberCount: number
  /** Total circle limit, including the overflow circle when needed. */
  maxFaces?: number
  /** The sidebar's agent rows, or Agent Home's title row (bigger, page colours, roster below). */
  variant?: keyof typeof VARIANTS
  className?: string
}) {
  const { data: members, isLoading, isError, refetch } = useAgentMembers(agentSlug, memberCount > 1)
  const v = VARIANTS[variant]
  // Test ids keep the sidebar's names there; Agent Home's are its own, as both show at once.
  const testId = variant === 'sidebar' ? 'sidebar-members' : 'agent-members'
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
          className={cn('relative z-10 inline-flex shrink-0 items-center justify-center rounded-control outline-none focus-visible:ring-2', variant === 'sidebar' ? 'h-6' : 'h-8', v.ring, className)}
          aria-label={`${count} members of ${agentName}`}
          data-testid={`${testId}-${agentSlug}`}
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
            {faces.map((member, i) => (
              <UserAvatar
                key={member.id}
                user={member}
                size={v.face}
                className={cn(v.overlapClass, 'first:ml-0')}
                style={i < faces.length - 1 ? cutout(v.face, v.overlap, v.face, v.gap) : remaining > 0 ? cutout(v.face, v.overlap, v.count, v.gap) : undefined}
              />
            ))}
            {/* When the faces don't fit, the last circle gives the whole
                team's size rather than how many are hidden. It stretches into
                a pill past two digits, keeping its round left end under the
                cut-out. */}
            {remaining > 0 && (
              <span
                className={cn('relative first:ml-0 inline-flex shrink-0 items-center justify-center rounded-full px-[3px] font-medium leading-none tabular-nums', v.overlapClass, v.countText, v.countFill)}
                style={{ minWidth: v.count, height: v.count }}
                data-testid={`${testId}-count-${agentSlug}`}
              >{count}</span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align={variant === 'sidebar' ? 'start' : 'end'}
        side={isMobile || variant === 'page' ? 'bottom' : 'right'}
        sideOffset={12}
        collisionPadding={12}
        className="w-[304px] max-w-[calc(100vw-24px)] p-2"
        aria-label={`${agentName} members`}
        data-testid={`${testId}-list-${agentSlug}`}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onPointerEnter={clearTimer}
        onPointerLeave={leave}
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
      </PopoverContent>
    </Popover>
  )
}
