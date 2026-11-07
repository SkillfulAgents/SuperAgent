import { cn } from '@shared/lib/utils/cn'
import type { UserSummary } from '@shared/lib/user-profile-schema'
import { UserAvatar } from '@renderer/components/ui/user-avatar'

const AVATAR_SIZE = 18
const OVERFLOW_SIZE = 19

// Each circle overlaps the one before it by 8px (-ml-2). Rather than a ring in
// the surface colour, which had to track the row's hover and selected fills,
// the circle underneath has a 1px gap cut out around the next one, so the row
// shows through. Centred on the next circle: it starts 10px in.
const CUTOUT_BEFORE_FACE = '[mask-image:radial-gradient(circle_at_19px_50%,transparent_9.5px,#000_10px)]'
const CUTOUT_BEFORE_OVERFLOW = '[mask-image:radial-gradient(circle_at_19.5px_50%,transparent_10px,#000_10.5px)]'

/**
 * Overlapping 18px faces, cut out rather than ringed so any row fill shows
 * between them. Decorative: the caller names the people.
 */
export function UserAvatarStack({ users, count = users.length, maxFaces = 4, className, overflowClassName, overflowTestId }: {
  /** At least the faces to show; more are ignored. */
  users: readonly UserSummary[]
  /** Everyone the stack stands for, when that is more than `users`. */
  count?: number
  /** Total circle limit, including the overflow circle when needed. */
  maxFaces?: number
  className?: string
  /** The overflow circle's fill and text colour, to suit the surface. */
  overflowClassName?: string
  overflowTestId?: string
}) {
  const circleLimit = Math.max(1, maxFaces)
  const faces = users.slice(0, count > circleLimit ? circleLimit - 1 : circleLimit)
  const remaining = count - faces.length
  return (
    <span aria-hidden="true" className={cn('pointer-events-none flex items-center', className)}>
      {faces.map((user, i) => (
        <UserAvatar
          key={user.id}
          user={user}
          size={AVATAR_SIZE}
          className={cn(
            '-ml-2 first:ml-0',
            i < faces.length - 1 ? CUTOUT_BEFORE_FACE : remaining > 0 && CUTOUT_BEFORE_OVERFLOW,
          )}
        />
      ))}
      {/* When the faces don't fit, the last circle gives the whole count
          rather than how many are hidden. It stretches into a pill past two
          digits, keeping its round left end under the cut-out. */}
      {remaining > 0 && (
        <span
          className={cn('relative -ml-2 first:ml-0 inline-flex shrink-0 items-center justify-center rounded-full px-[3px] text-[8px] font-medium leading-none tabular-nums', overflowClassName ?? 'bg-muted text-foreground')}
          style={{ minWidth: OVERFLOW_SIZE, height: OVERFLOW_SIZE }}
          data-testid={overflowTestId}
        >{count}</span>
      )}
    </span>
  )
}
