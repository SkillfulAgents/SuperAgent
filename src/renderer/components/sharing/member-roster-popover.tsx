import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'
import type { UserSummary } from '@shared/lib/user-profile-schema'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import type { MemberAgent } from '@shared/lib/types/agent-sharing'
import { UserAvatarStack } from '@renderer/components/ui/user-avatar-stack'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

const VARIANTS = {
  sidebar: {
    countFill: 'bg-[color-mix(in_srgb,hsl(var(--sidebar-foreground))_15%,hsl(var(--sidebar-background)))] text-sidebar-foreground',
    ring: 'focus-visible:ring-sidebar-ring',
  },
  page: {
    countFill: 'bg-[color-mix(in_srgb,hsl(var(--foreground))_10%,hsl(var(--background)))] text-foreground',
    ring: 'focus-visible:ring-ring',
  },
} as const

/** Hover or focus to preview the roster; clicking pins it for sharing. */
export function MemberRosterPopover({
  users, agents, count = users.length + (agents?.length ?? 0), maxFaces = 5, variant = 'page', label, title, rosterLabel,
  className, contentClassName, trigger, testIds, children,
}: {
  users: readonly UserSummary[]
  agents?: readonly MemberAgent[]
  count?: number
  maxFaces?: number
  variant?: keyof typeof VARIANTS
  label: string
  title?: string
  rosterLabel: string
  className?: string
  contentClassName?: string
  trigger?: ReactNode
  testIds?: { trigger: string; count: string; list: string }
  children: ReactNode
}) {
  const v = VARIANTS[variant]
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

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

  return (
    <Popover open={open} onOpenChange={next => next ? setOpen(true) : close()}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn('relative z-10 inline-flex shrink-0 items-center justify-center rounded-control outline-none focus-visible:ring-2', variant === 'sidebar' ? 'h-6' : 'h-8', v.ring, className)}
          aria-label={label}
          title={title}
          data-testid={testIds?.trigger}
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
          {trigger ?? <UserAvatarStack
            users={users} agents={agents}
            count={count}
            maxFaces={maxFaces}
            size={variant === 'page' ? 'md' : 'sm'}
            className="pl-0.5 pr-1"
            overflowClassName={v.countFill}
            overflowTestId={testIds?.count}
          />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align={variant === 'sidebar' ? 'start' : 'end'}
        side={isMobile || variant === 'page' ? 'bottom' : 'right'}
        sideOffset={12}
        collisionPadding={12}
        className={cn('w-[304px] max-w-[calc(100vw-24px)] p-2', contentClassName)}
        aria-label={rosterLabel}
        data-testid={testIds?.list}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onPointerDownCapture={() => {
          clearTimer()
          setPinned(true)
        }}
        onPointerEnter={clearTimer}
        onPointerLeave={leave}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
