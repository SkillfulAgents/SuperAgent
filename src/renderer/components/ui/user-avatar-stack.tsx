import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { MemberAgent } from '@shared/lib/types/agent-sharing'
import { cn } from '@shared/lib/utils/cn'
import type { UserSummary } from '@shared/lib/user-profile-schema'
import { UserAvatar } from '@renderer/components/ui/user-avatar'

const SIZES = {
  sm: { face: 18, count: 19, overlap: 8, gap: 0.5, overlapClass: '-ml-2', countText: 'text-[8px]' },
  md: { face: 24, count: 24, overlap: 10, gap: 1.5, overlapClass: '-ml-2.5', countText: 'text-[10px]' },
} as const

// Cut out the next circle so any surface shows through between faces.
function cutout(face: number, overlap: number, next: number, gap: number) {
  const radius = next / 2 + gap
  return { maskImage: `radial-gradient(circle at ${face - overlap + next / 2}px 50%, transparent ${radius}px, #000 ${radius + 0.5}px)` }
}

/**
 * Overlapping faces, cut out rather than ringed so any row fill shows
 * between them. Decorative: the caller names the people.
 */
export function UserAvatarStack({ users, agents = [], count = users.length + agents.length, maxFaces = 4, size = 'sm', className, overflowClassName, overflowTestId }: {
  /** At least the faces to show; more are ignored. */
  users: readonly UserSummary[]
  agents?: readonly MemberAgent[]
  /** Everyone the stack stands for, when that is more than the supplied faces. */
  count?: number
  /** Total circle limit, including the overflow circle when needed. */
  maxFaces?: number
  size?: keyof typeof SIZES
  className?: string
  /** The overflow circle's fill and text colour, to suit the surface. */
  overflowClassName?: string
  overflowTestId?: string
}) {
  const circleLimit = Math.max(1, maxFaces)
  const v = SIZES[size]
  const limit = count > circleLimit ? circleLimit - 1 : circleLimit
  const faces: (UserSummary | MemberAgent)[] = []
  for (let i = 0; faces.length < limit && i < Math.max(users.length, agents.length); i++) {
    if (users[i]) faces.push(users[i])
    if (agents[i] && faces.length < limit) faces.push(agents[i])
  }
  const remaining = count - faces.length
  return (
    <span aria-hidden="true" className={cn('pointer-events-none flex items-center', className)}>
      {faces.map((face, i) => {
        const overlap = cn(v.overlapClass, 'first:ml-0')
        const next = i < faces.length - 1 ? v.face : remaining > 0 ? v.count : 0
        const style = next ? cutout(v.face, v.overlap, next, v.gap) : undefined
        return 'slug' in face
          ? <span key={`agent:${face.slug}`} className={overlap} style={style}><AgentAvatar agent={face} size={v.face} still /></span>
          : <UserAvatar key={face.id} user={face} size={v.face} className={overlap} style={style} />
      })}
      {/* When the faces don't fit, the last circle gives the whole count
          rather than how many are hidden. It stretches into a pill past two
          digits, keeping its round left end under the cut-out. */}
      {remaining > 0 && (
        <span
          className={cn('relative first:ml-0 inline-flex shrink-0 items-center justify-center rounded-full px-[3px] font-medium leading-none tabular-nums', v.overlapClass, v.countText, overflowClassName ?? 'bg-muted text-foreground')}
          style={{ minWidth: v.count, height: v.count }}
          data-testid={overflowTestId}
        >{count}</span>
      )}
    </span>
  )
}
