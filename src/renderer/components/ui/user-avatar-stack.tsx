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
export function UserAvatarStack({ users, count = users.length, maxFaces = 4, size = 'sm', className, overflowClassName, overflowTestId }: {
  /** At least the faces to show; more are ignored. */
  users: readonly UserSummary[]
  /** Everyone the stack stands for, when that is more than `users`. */
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
  const faces = users.slice(0, count > circleLimit ? circleLimit - 1 : circleLimit)
  const remaining = count - faces.length
  const v = SIZES[size]
  return (
    <span aria-hidden="true" className={cn('pointer-events-none flex items-center', className)}>
      {faces.map((user, i) => (
        <UserAvatar
          key={user.id}
          user={user}
          size={v.face}
          className={cn(v.overlapClass, 'first:ml-0')}
          style={i < faces.length - 1 ? cutout(v.face, v.overlap, v.face, v.gap) : remaining > 0 ? cutout(v.face, v.overlap, v.count, v.gap) : undefined}
        />
      ))}
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
