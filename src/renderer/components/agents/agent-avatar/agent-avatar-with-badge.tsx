import type { ReactNode } from 'react'
import { AtSign } from 'lucide-react'
import type { ApiAgent } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils/cn'
import { AgentAvatar, type AvatarMotionState } from './agent-avatar'

/** Expanded sidebar rows show unread badges on their sessions instead. */
export function agentAvatarBadgeKind(agent: ApiAgent, state: AvatarMotionState, showUnread = true) {
  if (state === 'needs-input') return 'awaiting'
  if (!showUnread || !agent.hasUnreadNotifications) return null
  return agent.hasUnreadMention ? 'mention' : 'unread'
}

const badgeLabels = { awaiting: 'needs input', mention: 'mentioned you', unread: 'unread notifications' }

export function AgentAvatarWithBadge({
  agent,
  state,
  badge = agentAvatarBadgeKind(agent, state),
  size,
  followPointer,
  className,
  fallback,
}: {
  agent: ApiAgent
  state: AvatarMotionState
  badge?: ReturnType<typeof agentAvatarBadgeKind>
  size: number
  followPointer?: string
  className?: string
  fallback?: ReactNode
}) {
  const avatar = agent.avatar
    ? <AgentAvatar agent={agent} state={state} size={size} followPointer={followPointer} className={className} />
    : fallback
  const mention = badge === 'mention'
  const compact = size < 20

  // Cut a gap in the orb so the badge clears it on any row background. Padding
  // keeps the mask from clipping the needs-input hop. The centre is 5px inside
  // the avatar's corner (1px on the small avatars beside a result's owner).
  const inset = compact ? 1 : 5
  const badgeSize = mention ? (compact ? 10 : 14) : (compact ? 4 : 6)
  const offset = inset - badgeSize / 2
  const corner = 12 + inset
  const radius = badgeSize / 2 + (mention ? 0 : compact ? 1 : 2)
  const maskImage = badge
    ? `radial-gradient(circle at right ${corner}px bottom ${corner}px, transparent ${radius - 0.5}px, #000 ${radius}px)`
    : undefined
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className="pointer-events-none -m-3 box-content inline-flex items-center justify-center p-3"
        style={{ width: size, height: size, maskImage }}
      >
        {avatar}
      </span>
      {badge && (
        <span
          role="img"
          aria-label={badgeLabels[badge]}
          title={badgeLabels[badge]}
          data-testid={`agent-avatar-badge-${agent.slug}`}
          style={{ width: badgeSize, height: badgeSize, right: offset, bottom: offset }}
          className={cn(
            'pointer-events-none absolute flex items-center justify-center rounded-full',
            mention ? 'text-violet-600 dark:text-purple-400' : badge === 'awaiting' ? 'bg-orange-500' : 'bg-blue-500',
            className,
          )}
        >
          {mention && <AtSign className={compact ? 'size-2' : 'size-[11px]'} strokeWidth={3} aria-hidden />}
        </span>
      )}
    </span>
  )
}
