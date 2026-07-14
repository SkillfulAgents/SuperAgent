import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { HelpCircle } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils'
import { type EffortLevel } from '@shared/lib/container/types'

/** Full per-level names, shared by trigger buttons, the EffortSection header,
 *  and the slider's accessibility strings (aria-valuetext, tick aria-labels) —
 *  the bar itself shows just Faster/Smarter end labels; the current selection
 *  is displayed in the section header. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

// Half the track-pill height in px. Stops inset by this on each end so an end
// stop's knob and the fill's rounded cap sit fully inside the pill. All stop
// math (labels, dots, fill, thumb, and the click→index inverse) uses it, so the
// layers stay pixel-aligned regardless of the parent's padding. The knob (18px)
// is a hair smaller than the 20px track, so it nestles inside toggle-style.
const TRACK_R = 10

interface EffortSliderProps {
  /** Allowed efforts, low→high. One discrete stop each; length drives the geometry. */
  levels: EffortLevel[]
  /** Current value; must be one of `levels` (caller resets out-of-range values). */
  value: EffortLevel
  /** Value change — fires on click, arrow key, and once per level a drag crosses
   *  (never per pointer event: the settings hosts persist each call). */
  onChange: (level: EffortLevel) => void
}

/**
 * Discrete effort slider: a labeled stop per allowed level, a filled track up to
 * the current thumb, draggable/clickable/keyboard-driven. Each stop label carries
 * `data-testid="effort-option-<level>"` and selects that level on click, so it's a
 * drop-in for the old button list. Purely controlled — keeps no state of its own.
 */
export function EffortSlider({ levels, value, onChange }: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  // Last level emitted during the current gesture. Pointermove fires per pixel,
  // not per stop — without this dedup, hosts that persist on every onChange
  // (the settings selects PATCH live) get a mutation storm from one drag.
  const lastSent = useRef<EffortLevel | null>(null)

  const n = levels.length
  const activeIndex = Math.max(0, levels.indexOf(value))
  // Top tier ("Max") gets a celebratory animated rainbow-mesh fill; everything
  // below is a blue fill on a light-blue track.
  const maxedOut = value === 'max'
  const frac = (i: number) => (n > 1 ? i / (n - 1) : 0)
  // Stop i's center x, inset by the track radius on both ends.
  const pos = (i: number) => `calc(${TRACK_R}px + ${frac(i)} * (100% - ${TRACK_R * 2}px))`
  // Fill runs from the left edge to half a track-height past the active stop's
  // center, so its rounded right cap is CONCENTRIC with the knob (same center),
  // not tucked a cap-radius behind it. = pos(active) + TRACK_R.
  const fillWidth = `calc(${TRACK_R * 2}px + ${frac(activeIndex)} * (100% - ${TRACK_R * 2}px))`

  const indexFromClientX = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return activeIndex
    const rect = el.getBoundingClientRect()
    const usable = rect.width - TRACK_R * 2
    const t = usable > 0 ? (clientX - rect.left - TRACK_R) / usable : 0
    return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))
  }

  const emitFromPointer = (clientX: number) => {
    const level = levels[indexFromClientX(clientX)]
    if (level === lastSent.current) return
    lastSent.current = level
    onChange(level)
  }
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragging.current = true
    // Seed with the current value so pressing at the thumb's own stop is a no-op.
    lastSent.current = value
    e.currentTarget.setPointerCapture?.(e.pointerId)
    emitFromPointer(e.clientX)
  }
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    emitFromPointer(e.clientX)
  }
  // Ends a drag, including aborted gestures (touch interruption, OS gesture)
  // that never deliver pointerup. Without the reset, `dragging` sticks true and
  // plain hovers keep changing the effort until the next press.
  const endDrag = () => {
    dragging.current = false
    lastSent.current = null
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = activeIndex
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = activeIndex + 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = activeIndex - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else return
    e.preventDefault()
    next = Math.min(n - 1, Math.max(0, next))
    if (next !== activeIndex) onChange(levels[next])
  }

  return (
    <div className="px-2 pt-1 pb-2" data-testid="effort-slider">
      {/* Only the two poles are labeled — the ticks below carry the levels.
          Each pole pairs the speed/quality trade-off with its cost ($ vs $$$),
          slightly dimmer so the words stay primary. Color matches the section
          headers (e.g. "Effort · Medium"). */}
      <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground/70">
        <span>
          Faster <span className="text-muted-foreground/50">· $</span>
        </span>
        <span>
          Smarter <span className="text-muted-foreground/50">· $$$</span>
        </span>
      </div>
      {/* Track + thumb. The track is a pill slightly taller than the knob, so the
          knob nestles inside it (toggle style) rather than riding a thin rail. */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        className="relative h-5 cursor-pointer touch-none"
      >
        <div className="absolute inset-0 rounded-full bg-[#E1F6FF] dark:bg-[#15384F]" />
        <div
          data-testid="effort-fill"
          className={cn(
            'absolute inset-y-0 left-0 rounded-full bg-[#0099FF]',
            // Crossfade with the rainbow: the gray fades OUT exactly where the
            // rainbow fades IN, so the two never stack (stacking muddied the
            // rainbow's fade zone into a dingy blend).
            maxedOut && 'effort-fill-fade'
          )}
          style={{ width: fillWidth }}
        />
        {/* Tick dots: one per level, each a small click target for that level.
            They sit UNDER the rainbow overlay so they don't show through it —
            the opaque rainbow covers them, and they re-emerge where it fades
            out toward the left. A press on a tick deliberately bubbles to the
            track, which owns the whole gesture (emit at the pointer's stop,
            capture, drag) — the capture also retargets the resulting click to
            the track, so onClick only fires for keyboard/AT activation. */}
        {levels.map((level, i) => (
          <button
            key={level}
            type="button"
            data-testid={`effort-option-${level}`}
            aria-label={EFFORT_LABELS[level]}
            onClick={() => {
              if (level !== value) onChange(level)
            }}
            style={{ left: pos(i) }}
            className="group/tick absolute top-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
          >
            <span className="h-1 w-1 rounded-full bg-[#007DED] transition-transform duration-150 group-hover/tick:scale-150 dark:bg-[#4EB3FF]" />
          </button>
        ))}
        {maxedOut && (
          <div
            data-testid="effort-fill-rainbow"
            aria-hidden="true"
            // pointer-events-none: purely decorative — without it this overlay
            // hit-tests over the tick buttons (killing their hover feedback and
            // failing automated clicks on effort-option-* while at Max).
            className="pointer-events-none absolute inset-y-0 left-0 rounded-full effort-rainbow"
            style={{ width: fillWidth }}
          />
        )}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Effort"
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={activeIndex}
          aria-valuetext={EFFORT_LABELS[value]}
          onKeyDown={handleKeyDown}
          style={{ left: pos(activeIndex) }}
          className="absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background shadow-md ring-offset-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>
    </div>
  )
}

/**
 * Snap the effort back to Medium whenever the selected model disallows the
 * current one (e.g. Opus at Max, then switching to a 3-effort model). Medium is
 * the default effort and every model supports it. Shared by every surface that
 * pairs a model pick with an effort (composer popover, settings select,
 * quick-dispatch menu) so no host drifts out of the clamp — an unclamped host
 * renders the slider at Low (out-of-range values pin to index 0) while the
 * header and the dispatched request still carry the unsupported level.
 * Pass `model` as undefined to disable (model-only pickers).
 */
export function useEffortClamp(
  model: { supportedEfforts: EffortLevel[] } | undefined,
  effort: EffortLevel,
  onEffortChange: ((level: EffortLevel) => void) | undefined,
) {
  const supported = model?.supportedEfforts.includes(effort) ?? true
  useEffect(() => {
    if (model && !supported) onEffortChange?.('medium')
  }, [model, supported, onEffortChange])
}

/**
 * The complete effort block shared by every picker popover/menu: a header row
 * naming the selection ("Effort · Medium", value in the accent blue) with a
 * help tooltip explaining the trade-off, above the slider. No commit concept —
 * changes apply live and never dismiss the surface that hosts it.
 */
export function EffortSection({
  levels,
  value,
  onChange,
}: {
  levels: EffortLevel[]
  value: EffortLevel
  onChange: (level: EffortLevel) => void
}) {
  return (
    // A real wrapper (not a fragment): hosts reverse the popover column to keep
    // this section nearest the trigger, and a fragment's children would get
    // reordered individually (slider above its own header).
    <div>
      <div className="flex items-center justify-between px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground/70">
        <span>
          <span>Effort</span>
          <span className="text-[#007DED] dark:text-[#4EB3FF]"> · {EFFORT_LABELS[value]}</span>
        </span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About effort"
                data-testid="effort-help"
                className="inline-flex shrink-0 hover:text-foreground"
              >
                <HelpCircle className="h-3 w-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              Higher effort means more thorough responses, but takes longer and is more expensive.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <EffortSlider levels={levels} value={value} onChange={onChange} />
    </div>
  )
}
