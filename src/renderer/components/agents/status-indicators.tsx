import { useDotMatrixIndicators } from '@renderer/hooks/use-dot-matrix-indicators'
import { DotMatrix } from './dot-matrix'

/**
 * `classic` forces the legacy single-dot / 3-dot-wave render even when the
 * user has the dot-matrix preference turned on. Session-level indicators pass
 * this so the matrix stays reserved for agent-level expression.
 */
interface ClassicProp {
  classic?: boolean
}

export function WorkingDots({ dotClassName = 'bg-green-500', classic = false }: { dotClassName?: string } & ClassicProp = {}) {
  const dotMatrix = useDotMatrixIndicators()
  if (dotMatrix && !classic) {
    return (
      <DotMatrix
        pattern="march"
        size={3}
        cellPx={4}
        dotPx={2}
        dotClassName="bg-foreground"
        ariaLabel="working"
      />
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" role="img" aria-label="working">
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.15s] ${dotClassName}`} />
      <span className={`h-[3px] w-[3px] rounded-full animate-dot-wave [animation-delay:0.3s] ${dotClassName}`} />
    </span>
  )
}

export function AwaitingDot({ classic = false }: ClassicProp = {}) {
  const dotMatrix = useDotMatrixIndicators()
  if (dotMatrix && !classic) {
    return (
      <DotMatrix
        pattern="blink"
        size={3}
        cellPx={4}
        dotPx={2}
        dotClassName="bg-orange-500"
        ariaLabel="needs input"
      />
    )
  }
  // 12px outer wrapper reserves layout room around the 6px dot so the
  // `animate-ping` halo (rendered as a same-sized sibling that scales via transform)
  // isn't clipped by the parent row's `overflow-hidden`.
  return (
    <span className="relative flex items-center justify-center shrink-0 h-3 w-3" role="img" aria-label="needs input">
      <span className="animate-ping absolute inline-flex h-1.5 w-1.5 rounded-full bg-orange-500 opacity-75" />
      <span className="relative inline-flex rounded-full bg-orange-500 h-1.5 w-1.5" />
    </span>
  )
}

/**
 * Unread-notifications indicator. Classic = 6px blue dot;
 * dot-matrix mode = 3×3 blue pulse (matching the idle animation).
 */
export function UnreadDot({ classic = false }: ClassicProp = {}) {
  const dotMatrix = useDotMatrixIndicators()
  if (dotMatrix && !classic) {
    return (
      <DotMatrix
        pattern="pulse"
        size={3}
        cellPx={4}
        dotPx={2}
        dotClassName="bg-blue-500"
        ariaLabel="unread notifications"
      />
    )
  }
  return (
    <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" role="img" aria-label="unread notifications" />
  )
}

/**
 * Idle indicator — only renders when the dot-matrix preference is on; callers
 * keep their classic icon (e.g. CircleDashed) for the default case.
 */
export function IdleDots() {
  return (
    <DotMatrix
      pattern="pulse"
      size={3}
      cellPx={4}
      dotPx={2}
      dotClassName="bg-muted-foreground"
      ariaLabel="idle"
    />
  )
}
