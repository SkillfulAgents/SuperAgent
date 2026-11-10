import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Loader2 } from 'lucide-react'
import { useRouterState } from '@tanstack/react-router'
import { cn } from '@shared/lib/utils/cn'
import { AnimatedNavIcon } from '@renderer/components/ui/animated-nav-icon'
import { AppLink } from '@renderer/components/ui/app-link'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { FLOATING_COMPOSER_CLASS } from '@renderer/components/messages/chat-composer-box'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useTodos } from '@renderer/hooks/use-todos'
import { useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
import { usePlatformUnreadCount } from '@renderer/hooks/use-platform-notifications'

/**
 * True once `target` has scrolled fully out of `root`'s visible box. An
 * observer rather than a scroll handler, so it also answers when the target
 * changes height under a still scroll position (a status banner arriving).
 */
export function useScrolledAway(
  target: RefObject<HTMLElement>,
  root: RefObject<HTMLElement>,
): boolean {
  const [away, setAway] = useState(false)
  useEffect(() => {
    const el = target.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setAway(!entry.isIntersecting),
      { root: root.current },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [target, root])
  return away
}

const ITEM_CLASS =
  'relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-item text-muted-foreground outline-none ' +
  'ring-sidebar-ring transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 ' +
  'disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-foreground/10 data-[active=true]:text-foreground'

/** The corner dot a row's trailing dot becomes when the row is only an icon. */
function PillDot({ className, label }: { className: string; label: string }) {
  return (
    <span
      className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', className)}
      aria-label={label}
    />
  )
}

function PillTooltip({ label, showTooltip, children }: { label: string; showTooltip: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {showTooltip && <TooltipContent side="bottom">{label}</TooltipContent>}
    </Tooltip>
  )
}

interface PillLinkProps {
  to: '/' | '/notifications' | '/todo' | '/team-brain' | '/explore'
  label: string
  icon: 'home' | 'bell' | 'todo' | 'brain' | 'compass'
  isActive: boolean
  showTooltip: boolean
  testId: string
  children?: ReactNode
}

function PillLink({ to, label, icon, isActive, showTooltip, testId, children }: PillLinkProps) {
  return (
    <PillTooltip label={label} showTooltip={showTooltip}>
      <AppLink to={to} aria-label={label} data-active={isActive} data-testid={testId} className={ITEM_CLASS}>
        <AnimatedNavIcon name={icon} className="h-4 w-4" />
        {children}
      </AppLink>
    </PillTooltip>
  )
}

function NotificationsPillLink({ pathname, showTooltip }: { pathname: string; showTooltip: boolean }) {
  const { data: countData } = useUnreadNotificationCount()
  const { data: platformCountData } = usePlatformUnreadCount()
  const unreadCount = (countData?.count ?? 0) + (platformCountData?.count ?? 0)
  const unreadMentions = countData?.mentions ?? 0
  return (
    <PillLink
      to="/notifications"
      label="Notifications"
      icon="bell"
      isActive={pathname === '/notifications'}
      showTooltip={showTooltip}
      testId="nav-pill-notifications"
    >
      {unreadCount > 0 && (
        <PillDot
          className={unreadMentions > 0 ? 'bg-orange-500' : 'bg-blue-500'}
          label={unreadMentions > 0 ? `${unreadMentions} unread mentions` : `${unreadCount} unread`}
        />
      )}
    </PillLink>
  )
}

function TodoPillLink({ pathname, showTooltip }: { pathname: string; showTooltip: boolean }) {
  const { data: todos } = useTodos()
  const needsInput = todos?.filter((t) => t.column === 'needs_input').length ?? 0
  return (
    <PillLink
      to="/todo"
      label="Todo"
      icon="todo"
      isActive={pathname === '/todo'}
      showTooltip={showTooltip}
      testId="nav-pill-todo"
    >
      {needsInput > 0 && <PillDot className="bg-orange-500" label={`${needsInput} waiting on your input`} />}
    </PillLink>
  )
}

function findTeamBrainAgent(agents: ApiAgent[]): ApiAgent | undefined {
  return agents.find((agent) => agent.teamBrain)
}

function TeamBrainPillLink({ pathname, showTooltip }: { pathname: string; showTooltip: boolean }) {
  const { data: brainAgent } = useAgents({ select: findTeamBrainAgent, poll: false })
  const visited = pathname === '/team-brain' || (!!brainAgent && pathname.startsWith(`/agents/${brainAgent.displaySlug}`))
  return (
    <PillLink
      to="/team-brain"
      label="Team Brain"
      icon="brain"
      isActive={visited}
      showTooltip={showTooltip}
      testId="nav-pill-team-brain"
    />
  )
}

interface SidebarNavPillProps {
  /** Shown only while the full nav rows are scrolled out of view. */
  visible: boolean
  showTodo: boolean
  showTeamBrain: boolean
  showMarketplace: boolean
  isCreatingAgent: boolean
  onNewAgent: () => void
  /** No hover on touch, and a focus-opened tooltip there has no way to close. */
  showTooltips: boolean
}

/**
 * The sidebar's nav rows (Home through New Agent) as a floating row of icons,
 * for when the rows themselves have scrolled away with the agent list.
 *
 * Rendered as the first child of the sidebar's scroller: a zero-height sticky
 * anchor, so it takes no room in the list and floats over its top. The fade
 * and the lift sit on the glass element itself: opacity or a transform on an
 * ancestor would make that ancestor the backdrop root and leave the blur
 * nothing to sample. `invisible` takes the hidden pill out of the tab order
 * and away from the pointer.
 */
export function SidebarNavPill({
  visible,
  showTodo,
  showTeamBrain,
  showMarketplace,
  isCreatingAgent,
  onNewAgent,
  showTooltips,
}: SidebarNavPillProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <div className="pointer-events-none sticky top-0 z-20 h-0 shrink-0">
      <div className="absolute inset-x-0 top-2 flex justify-center">
        <nav
          aria-label="Quick navigation"
          aria-hidden={!visible}
          data-testid="sidebar-nav-pill"
          data-visible={visible}
          className={cn(
            FLOATING_COMPOSER_CLASS,
            // rounded-popover is rounded-item plus this p-1, so the corners sit
            // concentric with the items' own.
            'flex items-center gap-0.5 rounded-popover border p-1 backdrop-saturate-150 supports-[backdrop-filter]:bg-background/80',
            'transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none',
            visible
              ? 'pointer-events-auto visible translate-y-0 scale-100 opacity-100'
              : 'invisible -translate-y-1.5 scale-95 opacity-0',
          )}
        >
          <TooltipProvider delayDuration={200}>
            <PillLink
              to="/"
              label="Home"
              icon="home"
              isActive={pathname === '/'}
              showTooltip={showTooltips}
              testId="nav-pill-home"
            />
            <NotificationsPillLink pathname={pathname} showTooltip={showTooltips} />
            {showTodo && <TodoPillLink pathname={pathname} showTooltip={showTooltips} />}
            {showTeamBrain && <TeamBrainPillLink pathname={pathname} showTooltip={showTooltips} />}
            {showMarketplace && (
              <PillLink
                to="/explore"
                label="Discover New Agents"
                icon="compass"
                isActive={pathname === '/explore' || pathname.startsWith('/explore/')}
                showTooltip={showTooltips}
                testId="nav-pill-marketplace"
              />
            )}
            <PillTooltip label="New Agent" showTooltip={showTooltips}>
              <button
                type="button"
                onClick={onNewAgent}
                disabled={isCreatingAgent}
                aria-label="New Agent"
                data-testid="nav-pill-new-agent"
                className={ITEM_CLASS}
              >
                {isCreatingAgent
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <AnimatedNavIcon name="plus" className="h-4 w-4" />}
              </button>
            </PillTooltip>
          </TooltipProvider>
        </nav>
      </div>
    </div>
  )
}
