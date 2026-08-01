import { useCallback, useEffect, useRef, useState } from 'react'
import { Rocket } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils'

interface AutopilotToggleProps {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  /** Session's live autopilot state — drives the engaged glow. */
  engaged: boolean
  disabled?: boolean
}

/** Streaks staggered across the box height so the sweep reads as a field, not a single line. */
const WARP_LINES = [
  { top: '12%', width: '1.25rem', delay: '0.05s', duration: '0.45s' },
  { top: '28%', width: '2rem', delay: '0.3s', duration: '0.38s' },
  { top: '44%', width: '1.5rem', delay: '0s', duration: '0.55s' },
  { top: '60%', width: '2.5rem', delay: '0.18s', duration: '0.42s' },
  { top: '76%', width: '1.75rem', delay: '0.4s', duration: '0.5s' },
  { top: '90%', width: '1.25rem', delay: '0.12s', duration: '0.35s' },
]

/** Keep ≥ the longest animation (rocket fly-through 1s) so nothing gets cut mid-frame. */
const LAUNCH_MS = 1050

/**
 * Composer autopilot switch. Plain toggle while off/requested; once the agent
 * actually engages, the switch goes purple with a soft glow so the transition
 * from "asked for autopilot" to "flying itself" is visible at a glance.
 *
 * Flipping it ON plays a one-shot launch — the rocket flies out the top-right
 * corner (clipped at the box edge), re-enters from the bottom-left, and lands
 * back in its seat — while warp lines streak across for as long as the toggle
 * stays on.
 */
export function AutopilotToggle({ checked, onCheckedChange, engaged, disabled }: AutopilotToggleProps) {
  const [launching, setLaunching] = useState(false)
  const launchTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(launchTimerRef.current), [])

  // Only a user flip plays the launch — server-followed state changes (another
  // surface engaged it) arrive through `checked` without passing through here.
  const handleCheckedChange = useCallback(
    (v: boolean) => {
      if (v) {
        setLaunching(true)
        clearTimeout(launchTimerRef.current)
        launchTimerRef.current = setTimeout(() => setLaunching(false), LAUNCH_MS)
      }
      onCheckedChange(v)
    },
    [onCheckedChange]
  )

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <label
            className={cn(
              // Boxed to match the neighboring outline-style composer controls
              // (attachment picker, model selector). Clipping is launch-only:
              // permanent overflow-hidden would shave the engaged glow.
              // `isolate` scopes the warp overlay's -z-10: it sinks below the
              // rocket/label/switch but still paints above the box background.
              'relative isolate flex h-[34px] cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs font-medium shadow-sm transition-colors select-none hover:bg-accent',
              launching && 'overflow-hidden',
              engaged
                ? 'border-purple-500/50 text-purple-600 dark:text-purple-400'
                : checked
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-accent-foreground',
              disabled && 'cursor-not-allowed opacity-50'
            )}
            data-testid="autopilot-toggle"
          >
            <Rocket
              className={cn(
                'h-3.5 w-3.5',
                engaged && 'animate-pulse',
                launching && 'motion-safe:animate-rocket-launch'
              )}
            />
            <span className="hidden sm:inline">Autopilot</span>
            <Switch
              checked={checked}
              onCheckedChange={handleCheckedChange}
              disabled={disabled}
              aria-label="Autopilot"
              className={cn(
                'data-[state=checked]:bg-purple-600',
                engaged && 'shadow-[0_0_10px_2px] shadow-purple-500/60'
              )}
            />
            {checked && (
              // The overlay clips its own lines (they sweep past the box edge)
              // so the label never needs a permanent overflow-hidden.
              <span aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-md motion-reduce:hidden">
                {WARP_LINES.map((line, i) => (
                  <span
                    key={i}
                    className="absolute left-0 h-px animate-warp-line bg-gradient-to-r from-transparent via-purple-400/80 to-transparent"
                    style={{
                      top: line.top,
                      width: line.width,
                      animationDelay: line.delay,
                      animationDuration: line.duration,
                      // Hold the 0% keyframe (off-screen left, transparent)
                      // through the stagger delay instead of sitting mid-box.
                      animationFillMode: 'backwards',
                    }}
                  />
                ))}
              </span>
            )}
          </label>
        </TooltipTrigger>
        <TooltipContent side="top">
          {engaged
            ? 'Autopilot is engaged — the agent continues autonomously until the goal is met.'
            : checked
              ? 'Autopilot requested — the agent will verify it has everything it needs, then engage.'
              : 'Autopilot: the agent sees the task through autonomously, restarting itself until done.'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
