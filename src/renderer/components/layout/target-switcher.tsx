import { Cloud, Laptop } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import type { ApiTarget } from '@renderer/lib/api-target'

/**
 * Chooses which Superagent this app drives: the one on this computer, or the
 * organization's cloud workspace.
 *
 * Hidden entirely when there is no cloud workspace to switch to, so a
 * single-machine user never sees a control with one option.
 *
 * Sits in the sidebar's title-bar row, which is a fixed 48px shared with the
 * traffic lights and the history/search buttons — so it shows icons only, and
 * names them in a tooltip rather than in the button. The buttons are a fixed
 * size at every state: an earlier version expanded its labels in place on
 * hover, which moved the *other* option out from under a cursor already on its
 * way to it — you cannot grow the control the pointer is aiming through.
 */

/**
 * `label` names the option and is also its accessible name. It stays the same at
 * every state: `aria-pressed` is what tells a screen reader which one is on, so
 * a name that changed with state would be announced twice over.
 *
 * `hint` is why you would pick this one — the part neither the icon nor the
 * pressed state can carry.
 */
const options: {
  value: ApiTarget
  icon: typeof Laptop
  label: string
  hint: string
}[] = [
  {
    value: 'local',
    icon: Laptop,
    label: 'Local Agents (This computer)',
    hint: 'Most private and secure. Best browser use capabilities.',
  },
  {
    value: 'cloud',
    icon: Cloud,
    label: 'Cloud Agents',
    hint: 'Run 24/7. Access anywhere. Share and collaborate with your team',
  },
]

export function TargetSwitcher() {
  const { current, available, switching, switchTo } = useTargetSwitch()
  const isMobile = useIsMobile()

  if (!available) return null

  return (
    // `app-no-drag`: this lives in the window's drag region, where a plain
    // button would move the window instead of being pressed.
    <div
      className="app-no-drag flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
      role="group"
      aria-label="Where agents run"
      data-testid="target-switcher"
    >
      {/* Its own provider: this renders outside the one wrapping the header's
          history/search buttons.

          `disableHoverableContent` is what makes moving between the two options
          work. Hoverable content — the default — lets you travel from a trigger
          into its tooltip without it closing, and Radix implements that by
          drawing a grace polygon from the exit point around the content rect and
          suppressing *every* trigger in the provider while the pointer is inside
          it. Our content is far wider than the button it hangs under, so that
          polygon covers the other option: hovering A then B left B silently dead
          until the pointer wandered out of the hull. Nothing in these tooltips is
          worth hovering into, so the grace area is pure cost.

          `skipDelayDuration={0}` is what makes the delay hold on the *second*
          hover. Radix's default 300ms skip window opens any further tooltip in
          the provider instantly once one has been shown, so moving between the
          two options fired with no delay at all while the first hover waited —
          two different behaviours for the same gesture. Zero means both wait. */}
      <TooltipProvider delayDuration={400} skipDelayDuration={0} disableHoverableContent>
        {options.map(({ value, icon: Icon, label, hint }) => {
          const active = value === current
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  // The label is the accessible name — the button has no text of
                  // its own, and a tooltip is not a substitute for one.
                  aria-label={label}
                  aria-pressed={active}
                  // `aria-disabled`, not `disabled`: a disabled button emits no
                  // pointer events, so it cannot open a tooltip — and mid-switch
                  // is exactly when the user wants to be told what is happening.
                  // Clicks stay safe because `switchTo` ignores them while a
                  // switch is in flight.
                  aria-disabled={switching}
                  data-testid={`target-option-${value}`}
                  onClick={() => void switchTo(value)}
                  className={cn(
                    // Fixed at every state, so neither option shifts under a
                    // pointer travelling toward the other. Slightly wider than
                    // tall: the extra width is aim room on the axis the cursor
                    // actually approaches from, and it leaves the row's 48px
                    // height alone.
                    'flex h-6 w-8 items-center justify-center rounded transition-colors',
                    active
                      ? 'bg-background text-foreground shadow-sm cursor-default'
                      : 'text-muted-foreground hover:text-foreground',
                    switching && 'cursor-wait opacity-60',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                </button>
              </TooltipTrigger>
              {/* Suppressed on mobile for the same reason as the header's other
                  tooltips: no hover to dismiss, and the Sheet's focus-trap would
                  open one on the first focusable control with no way out.

                  `sideOffset` is 8 rather than the 4px default, so the panel reads
                  as its own surface instead of hanging off the button. Safe to
                  widen only because hoverable content is off — with it on, a
                  bigger gap is a bigger polygon to get stuck in. */}
              {!isMobile && (
                <TooltipContent side="bottom" sideOffset={8} className="max-w-52">
                  <span className="block">{switching ? 'Switching…' : label}</span>
                  {/* Why you would pick this one. Dropped mid-switch, where the
                      only useful thing to say is that the switch is under way. */}
                  {!switching && <span className="mt-0.5 block opacity-70">{hint}</span>}
                </TooltipContent>
              )}
            </Tooltip>
          )
        })}
      </TooltipProvider>
    </div>
  )
}
